import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
	completeSimple: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return {
		...actual,
		completeSimple: sdkMocks.completeSimple,
	};
});

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { testApiKey, testConfiguredProvider } from "../src/main/provider-validator";

function writeModelsConfig(config: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "look-provider-sdk-"));
	const file = join(dir, "models.json");
	writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
	return file;
}

function customProviderConfig() {
	return {
		providers: {
			"sdk-test": {
				name: "SDK Test Provider",
				baseUrl: "https://sdk-test.invalid/v1",
				apiKey: "literal-test-key",
				api: "openai-completions",
				headers: {
					"x-provider-header": "provider",
				},
				authHeader: true,
				models: [
					{
						id: "sdk-test-model",
						name: "SDK Test Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 4096,
						maxTokens: 128,
						headers: {
							"x-model-header": "model",
						},
					},
				],
			},
		},
	};
}

describe("pi SDK provider alignment", () => {
	afterEach(() => {
		sdkMocks.completeSimple.mockReset();
	});

	it("uses ModelRegistry custom providers as available SDK models", () => {
		const modelsPath = writeModelsConfig(customProviderConfig());
		const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);

		expect(registry.getAvailable().map((m) => `${m.provider}/${m.id}`)).toContain(
			"sdk-test/sdk-test-model",
		);
	});

	it("uses the SDK provider display name", () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());

		expect(registry.getProviderDisplayName("openai")).toBe("OpenAI");
	});

	it("uses the SDK MiniMax China model catalog", () => {
		const registry = ModelRegistry.inMemory(
			AuthStorage.inMemory({ "minimax-cn": { type: "api_key", key: "test-key" } }),
		);

		expect(registry.getAvailable().map((m) => `${m.provider}/${m.id}`)).toContain("minimax-cn/MiniMax-M3");
	});

	it("passes SDK-resolved provider and model headers to completeSimple", async () => {
		const modelsPath = writeModelsConfig(customProviderConfig());
		const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
		sdkMocks.completeSimple.mockImplementation(async (_model, _context, options) => {
			options?.onResponse?.({ status: 200, headers: {} });
			return {
				role: "assistant",
				content: [{ type: "text", text: "OK" }],
				api: "openai-completions",
				provider: "sdk-test",
				model: "sdk-test-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
		});

		const result = await testConfiguredProvider(registry, "sdk-test");

		expect(result).toEqual({ ok: true, status: 200 });
		expect(sdkMocks.completeSimple).toHaveBeenCalledTimes(1);
		const [, , options] = sdkMocks.completeSimple.mock.calls[0];
		expect(options.apiKey).toBe("literal-test-key");
		expect(options.headers).toMatchObject({
			"x-provider-header": "provider",
			"x-model-header": "model",
			Authorization: "Bearer literal-test-key",
		});
	});

	it("tests candidate API keys through SDK streaming", async () => {
		sdkMocks.completeSimple.mockImplementation(async (_model, _context, options) => {
			options?.onResponse?.({ status: 200, headers: {} });
			return {
				role: "assistant",
				content: [{ type: "text", text: "OK" }],
				api: "openai-completions",
				provider: "openai",
				model: "gpt-test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
		});

		const result = await testApiKey("openai", "sk-candidate");

		expect(result).toEqual({ ok: true, status: 200 });
		expect(sdkMocks.completeSimple).toHaveBeenCalledTimes(1);
		const [model, context, options] = sdkMocks.completeSimple.mock.calls[0];
		expect(model.provider).toBe("openai");
		expect(context.messages[0].content).toEqual("Hi");
		expect(options.apiKey).toBe("sk-candidate");
	});
});

describe("provider source regressions", () => {
	const runtimeManagerSource = readFileSync(resolve(__dirname, "../src/main/session-runtime-manager.ts"), "utf8");
	const validatorSource = readFileSync(resolve(__dirname, "../src/main/provider-validator.ts"), "utf8");
	const modelSelectorSource = readFileSync(resolve(__dirname, "../src/renderer/components/ModelSelector.tsx"), "utf8");

	it("does not hand-roll provider HTTP routing in main", () => {
		expect(runtimeManagerSource).not.toMatch(/node:https|httpsRequest/);
		expect(runtimeManagerSource).not.toMatch(/\bfindEnvKeys\b|\bgetModel\b/);
		expect(runtimeManagerSource).not.toMatch(/detectApiStyle|resolveBaseUrl|callAnthropicTitleApi/);
		expect(runtimeManagerSource).not.toMatch(/\/chat\/completions|\/v1\/messages|\/models\?key=/);
		expect(validatorSource).not.toMatch(/node:https|httpsRequest/);
		expect(validatorSource).not.toMatch(/UNTESTABLE_PROVIDERS|testOpenAIStyle|testAnthropicStyle|testGoogleStyle/);
		expect(validatorSource).not.toMatch(/\/chat\/completions|\/v1\/messages|\/models\?key=/);
	});

	it("does not require env providers to pass a second Look-owned verification gate", () => {
		expect(modelSelectorSource).not.toContain("getVerifiedEnvProviders");
		expect(modelSelectorSource).not.toContain("verifiedEnv");
	});
});
