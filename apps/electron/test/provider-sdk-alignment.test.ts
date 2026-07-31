import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testApiKey, testConfiguredProvider } from "../src/main/models/validator.js";

/** 伪造一次成功的 completeSimple（触发 onResponse 并返回正常 assistant 消息） */
function mockCompleteSimpleSuccess(provider: string, modelId: string) {
	return vi.spyOn(ModelRuntime.prototype, "completeSimple").mockImplementation(async (_model, _context, options) => {
		options?.onResponse?.({ status: 200, headers: {} });
		return {
			role: "assistant",
			content: [{ type: "text", text: "OK" }],
			api: "openai-completions",
			provider,
			model: modelId,
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
		} as never;
	});
}

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
		vi.restoreAllMocks();
	});

	it("uses ModelRegistry custom providers as available SDK models", async () => {
		const modelsPath = writeModelsConfig(customProviderConfig());
		const mr = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath });
		const registry = new ModelRegistry(mr);

		expect(registry.getAvailable().map((m) => `${m.provider}/${m.id}`)).toContain("sdk-test/sdk-test-model");
	});

	it("uses the SDK provider display name", async () => {
		const mr = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
		const registry = new ModelRegistry(mr);

		expect(registry.getProviderDisplayName("openai")).toBe("OpenAI");
	});

	it("uses the SDK MiniMax China model catalog", async () => {
		const creds = new InMemoryCredentialStore();
		await creds.modify("minimax-cn", async () => ({ type: "api_key", key: "test-key" }));
		const mr = await ModelRuntime.create({ credentials: creds });
		const registry = new ModelRegistry(mr);

		expect(registry.getAvailable().map((m) => `${m.provider}/${m.id}`)).toContain("minimax-cn/MiniMax-M3");
	});

	it("resolves the custom provider model and completes through ModelRuntime", async () => {
		const modelsPath = writeModelsConfig(customProviderConfig());
		const mr = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath });
		const completeSimpleSpy = mockCompleteSimpleSuccess("sdk-test", "sdk-test-model");

		const result = await testConfiguredProvider(mr, "sdk-test");

		expect(result).toEqual({ ok: true, status: 200 });
		expect(completeSimpleSpy).toHaveBeenCalledTimes(1);
		const [model] = completeSimpleSpy.mock.calls[0];
		// validator 通过 modelRuntime.getModels(provider) 取该 provider 的第一个模型；
		// apiKey/headers 由 ModelRuntime.prepareRequest 内部解析（SDK 职责，不在此断言）
		expect(model.provider).toBe("sdk-test");
		expect(model.id).toBe("sdk-test-model");
	});

	it("tests candidate API keys through ModelRuntime", async () => {
		const completeSimpleSpy = mockCompleteSimpleSuccess("openai", "gpt-test");
		const modifySpy = vi.spyOn(InMemoryCredentialStore.prototype, "modify");

		const result = await testApiKey("openai", "sk-candidate");

		expect(result).toEqual({ ok: true, status: 200 });
		expect(completeSimpleSpy).toHaveBeenCalledTimes(1);
		const [model, context] = completeSimpleSpy.mock.calls[0];
		expect(model.provider).toBe("openai");
		expect(context.messages[0].content).toEqual("Hi");
		// 候选 key 注入 InMemoryCredentialStore（Look 侧职责；后续鉴权由 SDK 完成）
		expect(modifySpy).toHaveBeenCalledWith("openai", expect.any(Function));
		const credential = await modifySpy.mock.calls[0][1](undefined as never);
		expect(credential).toEqual({ type: "api_key", key: "sk-candidate" });
	});
});

describe("provider source regressions", () => {
	const runtimeManagerSource = readFileSync(resolve(__dirname, "../src/main/session/runtime/runtime-manager.ts"), "utf8");
	const validatorSource = readFileSync(resolve(__dirname, "../src/main/models/validator.ts"), "utf8");
	const modelSelectorSource = readFileSync(
		resolve(__dirname, "../src/renderer/components/chat/ModelSelector.tsx"),
		"utf8",
	);

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
