// ============================================================
// Provider Validator — SDK-native provider self-test
//
// Look must not maintain provider-specific routing, URL probing, or
// auth/header rules. Validation runs a tiny request through the same
// pi SDK path as real agent traffic:
//
//   ModelRegistry -> getApiKeyAndHeaders(model) -> completeSimple()
// ============================================================

import {
	type Api,
	type AssistantMessage,
	completeSimple,
	type Model,
	type ProviderResponse,
} from "@earendil-works/pi-ai/compat";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getModelsPath } from "@look/shared/look-storage";

export type TestResult =
	| { ok: true; status: number; skipped?: false }
	| { ok: false; status: number; error: string; skipped?: false }
	| { skipped: true; reason: string };

const SELF_TEST_PROMPT = "Hi";
const SELF_TEST_TIMEOUT_MS = 10_000;

function firstProviderModel(modelRegistry: ModelRegistry, provider: string): Model<Api> | undefined {
	return modelRegistry.getAll().find((m) => m.provider === provider);
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

async function runSdkSelfTest(modelRegistry: ModelRegistry, provider: string): Promise<TestResult> {
	const model = firstProviderModel(modelRegistry, provider);
	if (!model) {
		return { skipped: true, reason: `No SDK model configured for "${provider}"` };
	}

	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { ok: false, status: 0, error: auth.error };
	}

	let status = 0;
	let message: AssistantMessage;
	try {
		message = await completeSimple(
			model,
			{
				messages: [{ role: "user", content: SELF_TEST_PROMPT, timestamp: Date.now() }],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens: 1,
				timeoutMs: SELF_TEST_TIMEOUT_MS,
				maxRetries: 0,
				onResponse: (response: ProviderResponse) => {
					status = response.status;
				},
			},
		);
	} catch (error) {
		const message = normalizeError(error);
		if (message.includes("No API provider registered for api:")) {
			return { skipped: true, reason: message };
		}
		return { ok: false, status, error: message };
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

	const authStorage = AuthStorage.inMemory({ [provider]: { type: "api_key", key: trimmed } });
	const modelRegistry = ModelRegistry.create(authStorage, getModelsPath());
	return runSdkSelfTest(modelRegistry, provider);
}

/**
 * Test the currently configured SDK auth for a provider. This is used
 * for environment, OAuth, and models.json-backed auth sources; Look
 * does not read process.env or provider-specific config itself.
 */
export async function testConfiguredProvider(modelRegistry: ModelRegistry, provider: string): Promise<TestResult> {
	return runSdkSelfTest(modelRegistry, provider);
}
