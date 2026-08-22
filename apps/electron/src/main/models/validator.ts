// ============================================================
// Provider Validator — SDK-native provider self-test
//
// Look must not maintain provider-specific routing, URL probing, or
// auth/header rules. Validation runs a tiny request through the same
// pi SDK path as real agent traffic:
//
//   ModelRuntime.completeSimple() — handles auth internally
// ============================================================

import type { Api, AssistantMessage, Model, ProviderResponse } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type TestResult =
	| { ok: true; status: number; skipped?: false }
	| { ok: false; status: number; error: string; skipped?: false }
	| { skipped: true; reason: string };

const SELF_TEST_PROMPT = "Hi";
const SELF_TEST_TIMEOUT_MS = 10_000;

function firstProviderModel(modelRuntime: ModelRuntime, provider: string): Model<Api> | undefined {
	const models = modelRuntime.getModels(provider);
	return models.length > 0 ? models[0] : undefined;
}

function normalizeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

async function runSdkSelfTest(modelRuntime: ModelRuntime, provider: string): Promise<TestResult> {
	const model = firstProviderModel(modelRuntime, provider);
	if (!model) {
		return { skipped: true, reason: `No SDK model configured for "${provider}"` };
	}

	let status = 0;
	let message: AssistantMessage;
	try {
		message = await modelRuntime.completeSimple(
			model,
			{
				messages: [{ role: "user", content: SELF_TEST_PROMPT, timestamp: Date.now() }],
			},
			{
				maxTokens: 1,
				timeoutMs: SELF_TEST_TIMEOUT_MS,
				maxRetries: 0,
				onResponse: (response: ProviderResponse) => {
					status = response.status;
				},
			},
		);
	} catch (error) {
		const errMsg = normalizeError(error);
		if (errMsg.includes("No API provider registered for api:")) {
			return { skipped: true, reason: errMsg };
		}
		return { ok: false, status, error: errMsg };
	}

	if (message.stopReason === "error") {
		return { ok: false, status, error: message.errorMessage ?? "Provider returned an error" };
	}

	return { ok: true, status: status || 200 };
}

/**
 * Test a candidate stored API key for a provider by injecting it into
 * an in-memory SDK AuthStorage and executing the provider through the
 * SDK model/provider stack. This intentionally uses ~/.look/models.json
 * so custom provider definitions and overrides are included.
 */
export async function testApiKey(provider: string, key: string): Promise<TestResult> {
	const trimmed = key?.trim() ?? "";
	if (!trimmed) {
		return { ok: false, status: 0, error: "Empty key" };
	}

	const credentials = new InMemoryCredentialStore();
	await credentials.modify(provider, async () => ({ type: "api_key" as const, key: trimmed }));
	const modelRuntime = await ModelRuntime.create({ credentials });
	return runSdkSelfTest(modelRuntime, provider);
}

/**
 * Test the currently configured SDK auth for a provider. This is used
 * for environment, OAuth, and models.json-backed auth sources; Look
 * does not read process.env or provider-specific config itself.
 */
export async function testConfiguredProvider(modelRuntime: ModelRuntime, provider: string): Promise<TestResult> {
	return runSdkSelfTest(modelRuntime, provider);
}

export interface CustomProviderTestEntry {
	modelId: string;
	ok: boolean;
	latencyMs?: number;
	error?: string;
}

export interface CustomProviderTestResult {
	overall: "ok" | "fail";
	results: CustomProviderTestEntry[];
}

/**
 * 自定义 provider 候选的逐模型连通性自测：把候选注入内存
 * ModelRuntime（不落盘、不污染全局注册表），对每个声明模型跑
 * 一次 maxTokens=1 的 completeSimple。注册失败整体 fail。
 */
export async function testCustomProvider(input: {
	name: string;
	apiKey?: string;
	models: Array<{ id: string }>;
	providerConfig: Parameters<ModelRuntime["registerProvider"]>[1];
}): Promise<CustomProviderTestResult> {
	const memCredentials = new InMemoryCredentialStore();
	if (input.apiKey) {
		await memCredentials.modify(input.name, async () => ({ type: "api_key" as const, key: input.apiKey }));
	}
	const memRuntime = await ModelRuntime.create({ credentials: memCredentials });
	try {
		memRuntime.registerProvider(input.name, input.providerConfig);
	} catch (e) {
		return {
			overall: "fail",
			results: [{ modelId: "registration", ok: false, error: normalizeError(e) }],
		};
	}

	const results = await Promise.all(
		input.models.map(async (m): Promise<CustomProviderTestEntry> => {
			const start = Date.now();
			try {
				const model = memRuntime.getModel(input.name, m.id);
				if (!model) {
					return { modelId: m.id, ok: false, error: "model not found in in-memory registry" };
				}
				let status = 0;
				const message = await memRuntime.completeSimple(
					model,
					{ messages: [{ role: "user", content: SELF_TEST_PROMPT, timestamp: Date.now() }] },
					{
						maxTokens: 1,
						timeoutMs: SELF_TEST_TIMEOUT_MS,
						maxRetries: 0,
						onResponse: (response: ProviderResponse) => {
							status = response.status;
						},
					},
				);
				if (message.stopReason === "error") {
					return { modelId: m.id, ok: false, error: message.errorMessage ?? `HTTP ${status}` };
				}
				return { modelId: m.id, ok: true, latencyMs: Date.now() - start };
			} catch (e) {
				return { modelId: m.id, ok: false, error: normalizeError(e) };
			}
		}),
	);
	const overall = results.every((r) => r.ok) ? "ok" : "fail";
	return { overall, results };
}
