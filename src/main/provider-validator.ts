// ============================================================
// Provider Validator — Live API key self-test
//
// Each provider maps to a lightweight list/whoami endpoint we
// can hit with the candidate key to confirm it's accepted.
//
// Two strategies:
//   - OpenAI-compatible: GET {baseUrl}/models (no token burn)
//   - Anthropic-compatible: POST {baseUrl}/messages with max_tokens=1
//     because Anthropic's /v1/models is admin-only (returns 403 for
//     normal API keys). Uses a minimal prompt to burn < 10 tokens.
//
// Base URL resolution: checks {PROVIDER}_BASE_URL env var first
// (e.g. ANTHROPIC_BASE_URL), falls back to the hardcoded default.
// This is essential for users who use proxy/compatible endpoints
// (e.g. DeepSeek's Anthropic-compatible API at api.deepseek.com/anthropic).
//
// Outcome is one of:
//   - { ok: true,  status: <2xx> }            key works
//   - { ok: false, status: <http>, error }   key rejected (401/403/etc.)
//   - { ok: false, status: 0,    error }     network / DNS / TLS failure
//   - { skipped: true }                       no test configured for this
//                                             provider — UI treats as a
//                                             neutral state, save still
//                                             allowed.
//
// A non-2xx response is a *rejection*, not an error. We surface the
// provider's own error body (truncated) so the user can see why
// their key was rejected ("invalid x-api-key", "insufficient
// quota", etc.) without leaving the app.
// ============================================================

import { request as httpsRequest } from "node:https";

export type TestResult =
	| { ok: true; status: number; skipped?: false }
	| { ok: false; status: number; error: string; skipped?: false }
	| { skipped: true; reason: string };

type ApiStyle = "openai" | "anthropic" | "google";

interface ProviderTest {
	api: ApiStyle;
	defaultBaseUrl: string;
}

// ---- Provider config table ----
const PROVIDER_CONFIG: Record<string, ProviderTest> = {
	// ── Anthropic-compatible (POST /messages) ──
	anthropic: {
		api: "anthropic",
		defaultBaseUrl: "https://api.anthropic.com",
	},
	minimax: {
		api: "anthropic",
		defaultBaseUrl: "https://api.minimax.io/anthropic",
	},
	"minimax-cn": {
		api: "anthropic",
		defaultBaseUrl: "https://api.minimaxi.com/anthropic",
	},

	// ── OpenAI-compatible (GET /models) ──
	openai: {
		api: "openai",
		defaultBaseUrl: "https://api.openai.com/v1",
	},
	deepseek: {
		api: "openai",
		defaultBaseUrl: "https://api.deepseek.com",
	},
	mistral: {
		api: "openai",
		defaultBaseUrl: "https://api.mistral.ai/v1",
	},
	groq: {
		api: "openai",
		defaultBaseUrl: "https://api.groq.com/openai/v1",
	},
	cerebras: {
		api: "openai",
		defaultBaseUrl: "https://api.cerebras.ai/v1",
	},
	xai: {
		api: "openai",
		defaultBaseUrl: "https://api.x.ai/v1",
	},
	openrouter: {
		api: "openai",
		defaultBaseUrl: "https://openrouter.ai/api/v1",
	},
	fireworks: {
		api: "openai",
		defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
	},
	together: {
		api: "openai",
		defaultBaseUrl: "https://api.together.xyz/v1",
	},
	huggingface: {
		api: "openai",
		defaultBaseUrl: "https://huggingface.co/api",
	},
	vercel: {
		api: "openai",
		defaultBaseUrl: "https://ai-gateway.vercel.sh/v1",
	},
	zai: {
		api: "openai",
		defaultBaseUrl: "https://api.z.ai/api/paas/v4",
	},
	"kimi-coding": {
		api: "openai",
		defaultBaseUrl: "https://api.moonshot.cn/v1",
	},
	moonshotai: {
		api: "openai",
		defaultBaseUrl: "https://api.moonshot.ai/v1",
	},
	"moonshotai-cn": {
		api: "openai",
		defaultBaseUrl: "https://api.moonshot.cn/v1",
	},
	xiaomi: {
		api: "openai",
		defaultBaseUrl: "https://api.xiaomimimo.com/v1",
	},
	"xiaomi-token-plan-cn": {
		api: "openai",
		defaultBaseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
	},
	"xiaomi-token-plan-ams": {
		api: "openai",
		defaultBaseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
	},
	"xiaomi-token-plan-sgp": {
		api: "openai",
		defaultBaseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
	},

	// ── Google (key in query string) ──
	google: {
		api: "google",
		defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
	},
};

/**
 * Providers that use complex authentication (AWS IAM, OAuth, device
 * flow, custom headers, user-specific resource URLs) and cannot be
 * tested through a simple API-key probe.
 */
const KNOWN_UNTESTABLE_PROVIDERS: ReadonlySet<string> = new Set([
	"amazon-bedrock",
	"google-vertex",
	"azure-openai-responses",
	"openai-codex",
	"github-copilot",
	"opencode",
	"opencode-go",
	"cloudflare-workers-ai",
	"cloudflare-ai-gateway",
]);

/**
 * Resolve the effective base URL for a provider.
 * Checks {PROVIDER}_BASE_URL env var (pi SDK convention), falls back
 * to the hardcoded default.
 */
export function resolveBaseUrl(provider: string): string {
	const cfg = PROVIDER_CONFIG[provider];
	const defaultUrl = cfg?.defaultBaseUrl ?? `https://api.${provider}.com`;
	const envKey = `${provider.toUpperCase().replace(/-/g, "_")}_BASE_URL`;
	return process.env[envKey] || defaultUrl;
}

/**
 * Test a candidate key against the provider's self-test endpoint.
 * @param provider - provider id (e.g. "anthropic", "openai")
 * @param key - the API key to test
 * @param baseUrl - optional override for the base URL (falls back to env var or default)
 */
export async function testApiKey(provider: string, key: string, baseUrl?: string): Promise<TestResult> {
	if (KNOWN_UNTESTABLE_PROVIDERS.has(provider)) {
		return { skipped: true, reason: "使用复杂认证（AWS IAM / ADC / OAuth），请手动测试" };
	}
	const cfg = PROVIDER_CONFIG[provider];
	if (!cfg) {
		return { skipped: true, reason: `No self-test configured for "${provider}"` };
	}
	if (!key || !key.trim()) {
		return { ok: false, status: 0, error: "Empty key" };
	}

	const effectiveBaseUrl = baseUrl || resolveBaseUrl(provider);

	try {
		const res = await (cfg.api === "anthropic"
			? testAnthropicStyle(effectiveBaseUrl, key)
			: cfg.api === "google"
				? testGoogleStyle(effectiveBaseUrl, key)
				: testOpenAIStyle(effectiveBaseUrl, key));

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

/** OpenAI style: GET {baseUrl}/models with Bearer auth */
async function testOpenAIStyle(baseUrl: string, key: string) {
	const url = `${baseUrl}/models`;
	const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
	return httpGet(url, headers, 10_000);
}

/** Anthropic style: POST {baseUrl}/messages with x-api-key, burn ≤ 10 tokens */
async function testAnthropicStyle(baseUrl: string, key: string) {
	const url = `${baseUrl}/messages`;
	const headers: Record<string, string> = {
		"x-api-key": key,
		"anthropic-version": "2023-06-01",
		"content-type": "application/json",
	};
	const body = JSON.stringify({
		model: "claude-haiku-4-5-20251001",
		max_tokens: 1,
		messages: [{ role: "user", content: "hi" }],
	});
	return httpPost(url, headers, body, 10_000);
}

/** Google style: GET {baseUrl}/models?key={key} */
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
