// ============================================================
// Provider Validator — Live API key self-test
//
// Derives provider metadata (API style, baseUrl, test model) from
// @earendil-works/pi-ai's auto-generated MODELS registry so Look
// never drifts from upstream provider catalog changes.
//
// Each provider maps to a lightweight list/whoami endpoint we
// can hit with the candidate key to confirm it's accepted.
//
// Three strategies:
//   - Anthropic Messages API: POST {baseUrl}/v1/messages with max_tokens=1
//     (matches Anthropic protocol — same path pi SDK uses via @anthropic-ai/sdk)
//   - OpenAI-compatible: GET {baseUrl}/models (no token burn)
//   - Google: GET {baseUrl}/models?key={key}
//
// Base URL resolution: checks {PROVIDER}_BASE_URL env var first
// (e.g. ANTHROPIC_BASE_URL), falls back to the MODELS baseUrl.
//
// Outcome is one of:
//   - { ok: true,  status: <2xx> }            key works
//   - { ok: false, status: <http>, error }   key rejected (401/403/etc.)
//   - { ok: false, status: 0,    error }     network / DNS / TLS failure
//   - { skipped: true }                       no test configured for this
//                                             provider — UI treats as a
//                                             neutral state, save still
//                                             allowed.
// ============================================================

import { request as httpsRequest } from "node:https";
import { getModels } from "@earendil-works/pi-ai";

export type TestResult =
	| { ok: true; status: number; skipped?: false }
	| { ok: false; status: number; error: string; skipped?: false }
	| { skipped: true; reason: string };

type TestStrategy = "openai" | "anthropic" | "google";

interface TestConfig {
	strategy: TestStrategy;
	baseUrl: string;
	testModel: string;
}

/**
 * Providers that use OAuth, multi-variable cloud auth, or device-flow
 * login. Their keys cannot be validated with a simple HTTP probe.
 */
const UNTESTABLE_PROVIDERS: ReadonlySet<string> = new Set([
	"amazon-bedrock",          // AWS IAM / profile / bearer token
	"google-vertex",           // ADC or explicit API key + project + location
	"azure-openai-responses",  // Azure resource-level auth
	"openai-codex",            // ChatGPT Plus/Pro OAuth
	"github-copilot",          // GitHub OAuth device flow
	"opencode",                // OpenCode OAuth
	"opencode-go",             // OpenCode Go OAuth
	"cloudflare-workers-ai",   // needs CLOUDFLARE_ACCOUNT_ID
	"cloudflare-ai-gateway",   // needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_GATEWAY_ID
]);

/**
 * Derive test config from pi SDK's MODELS registry.
 * Returns null if the provider cannot be tested with a simple HTTP probe.
 */
function getTestConfig(provider: string): TestConfig | null {
	if (UNTESTABLE_PROVIDERS.has(provider)) return null;

	const models = getModels(provider as Parameters<typeof getModels>[0]);
	const first = models?.[0];
	if (!first) return null;

	const api: string = first.api;
	const sdkBaseUrl: string = first.baseUrl;
	const modelId: string = first.id;

	switch (api) {
		case "anthropic-messages":
			return { strategy: "anthropic", baseUrl: sdkBaseUrl, testModel: modelId };

		case "openai-completions":
		case "openai-responses":
			return { strategy: "openai", baseUrl: sdkBaseUrl, testModel: modelId };

		// Mistral uses its own native SDK but exposes an OpenAI-compatible /v1/models endpoint.
		// pi SDK baseUrl for mistral is "https://api.mistral.ai" (no /v1 suffix).
		case "mistral-conversations":
			return {
				strategy: "openai",
				baseUrl: sdkBaseUrl.endsWith("/v1") ? sdkBaseUrl : `${sdkBaseUrl}/v1`,
				testModel: modelId,
			};

		case "google-generative-ai":
			return { strategy: "google", baseUrl: sdkBaseUrl, testModel: modelId };

		// bedrock-converse-stream, azure-openai-responses, openai-codex-responses,
		// google-vertex — all use complex auth and are already in UNTESTABLE_PROVIDERS.
		default:
			return null;
	}
}

/**
 * Resolve the effective base URL for a provider.
 * Checks {PROVIDER}_BASE_URL env var (pi SDK convention), falls back
 * to the MODELS registry baseUrl.
 */
export function resolveBaseUrl(provider: string): string {
	const envKey = `${provider.toUpperCase().replace(/-/g, "_")}_BASE_URL`;
	if (process.env[envKey]) return process.env[envKey];

	const cfg = getTestConfig(provider);
	if (cfg) return cfg.baseUrl;

	// Last resort for unknown providers
	return `https://api.${provider}.com`;
}

/**
 * Test a candidate key against the provider's self-test endpoint.
 * @param provider - provider id (e.g. "anthropic", "openai")
 * @param key - the API key to test
 * @param baseUrl - optional override for the base URL (falls back to env var or MODELS default)
 */
export async function testApiKey(provider: string, key: string, baseUrl?: string): Promise<TestResult> {
	if (UNTESTABLE_PROVIDERS.has(provider)) {
		return { skipped: true, reason: "使用复杂认证（AWS IAM / ADC / OAuth），请手动测试" };
	}
	if (!key || !key.trim()) {
		return { ok: false, status: 0, error: "Empty key" };
	}

	const cfg = getTestConfig(provider);
	if (!cfg) {
		return { skipped: true, reason: `No self-test configured for "${provider}"` };
	}

	const effectiveBaseUrl = baseUrl || resolveBaseUrl(provider);

	try {
		const res =
			cfg.strategy === "anthropic"
				? await testAnthropicStyle(effectiveBaseUrl, key, cfg.testModel)
				: cfg.strategy === "google"
					? await testGoogleStyle(effectiveBaseUrl, key)
					: await testOpenAIStyle(effectiveBaseUrl, key);

		if (res.ok) return { ok: true, status: res.status };
		const friendly = extractErrorMessage(res.body) || `HTTP ${res.status}`;
		return { ok: false, status: res.status, error: friendly };
	} catch (e: any) {
		console.error(`[Look] Self-test failed for ${provider}:`, {
			url: effectiveBaseUrl,
			message: e.message,
			code: e.code,
		});
		if (e?.code === "ETIMEDOUT" || e?.code === "ECONNABORTED") {
			return { ok: false, status: 0, error: "Request timed out (10s)" };
		}
		return { ok: false, status: 0, error: e?.message ?? "Network error" };
	}
}

// ── Test strategies ──

/** OpenAI-compatible: GET {baseUrl}/models with Bearer auth */
async function testOpenAIStyle(baseUrl: string, key: string) {
	const url = `${baseUrl}/models`;
	const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
	return httpGet(url, headers, 10_000);
}

/** Anthropic Messages API: POST {baseUrl}/v1/messages with x-api-key, burn ≤ 10 tokens */
async function testAnthropicStyle(baseUrl: string, key: string, model?: string) {
	const url = `${baseUrl}/v1/messages`;
	const headers: Record<string, string> = {
		"x-api-key": key,
		"anthropic-version": "2023-06-01",
		"content-type": "application/json",
	};
	const body = JSON.stringify({
		model: model ?? "claude-haiku-4-5-20251001",
		max_tokens: 1,
		messages: [{ role: "user", content: "hi" }],
	});
	return httpPost(url, headers, body, 10_000);
}

/** Google Generative Language API: GET {baseUrl}/models?key={key} */
async function testGoogleStyle(baseUrl: string, key: string) {
	const url = `${baseUrl}/models?key=${encodeURIComponent(key)}`;
	return httpGet(url, {}, 10_000);
}

// ── HTTP primitives ──

function httpGet(requestUrl: string, headers: Record<string, string>, timeoutMs: number): Promise<HttpResult> {
	const { hostname, pathname, search, port } = new URL(requestUrl);
	const path = pathname + search;
	return httpRequest("GET", hostname, port, path, headers, null, timeoutMs);
}

function httpPost(
	requestUrl: string,
	headers: Record<string, string>,
	body: string,
	timeoutMs: number,
): Promise<HttpResult> {
	const { hostname, pathname, search, port } = new URL(requestUrl);
	const path = pathname + search;
	return httpRequest("POST", hostname, port, path, headers, body, timeoutMs);
}

interface HttpResult {
	ok: boolean;
	status: number;
	body: string;
}

function httpRequest(
	method: string,
	hostname: string,
	port: string,
	path: string,
	headers: Record<string, string>,
	body: string | null,
	timeoutMs: number,
): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const req = httpsRequest(
			{
				hostname,
				port: port || 443,
				path,
				method,
				headers,
			},
			(res) => {
				let data = "";
				res.setEncoding("utf-8");
				res.on("data", (chunk: string) => {
					data += chunk;
				});
				res.on("end", () => {
					resolve({
						ok: res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300,
						status: res.statusCode ?? 0,
						body: data,
					});
				});
			},
		);
		const timer = setTimeout(() => {
			req.destroy();
			reject(Object.assign(new Error("Request timed out (10s)"), { code: "ETIMEDOUT" }));
		}, timeoutMs);
		req.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		req.on("close", () => clearTimeout(timer));
		if (body) req.write(body);
		req.end();
	});
}

function extractErrorMessage(body: string): string {
	if (!body) return "";
	const trimmed = body.slice(0, 800);
	try {
		const j = JSON.parse(trimmed);
		if (j?.error?.message) return String(j.error.message);
		if (typeof j?.error === "string") return j.error;
		if (j?.message) return String(j.message);
	} catch {
		/* not JSON — fall through */
	}
	return trimmed;
}
