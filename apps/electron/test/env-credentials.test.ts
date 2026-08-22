// ============================================================
// Environment-variable credentials ARE recognized as configured.
//
// pi-ai detects API keys in the process environment (merged from the
// user's shell rc files by shell-env.ts at startup) and reports
// { configured: true, source: "environment", label: "<ENV_NAME>" }.
// Look treats those providers as configured — same as pi CLI — so
// their model lists show up in settings and the model selector.
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAvailableModels, getProviderSettings } from "../src/main/models/model-queries.js";
import { CustomProvidersStore } from "../src/main/settings/custom-providers.js";

function tmpDir(): string {
	const dir = path.join(os.tmpdir(), `look-env-cred-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

describe("environment-variable credentials are recognized as configured by Look", () => {
	let dir: string;

	beforeEach(() => {
		dir = tmpDir();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("treats ANTHROPIC_API_KEY env var as configured (hasKey, models, source=environment, envVar hint)", async () => {
		// pi-ai 的 anthropic 解析优先级: AUTH_TOKEN(Bearer) > OAUTH_TOKEN > API_KEY。
		// 本机 shell 可能已导出 ANTHROPIC_AUTH_TOKEN, 不清空会被它抢跑导致断言失败;
		// 这里显式清空高优先级变量, 只留 API_KEY 验证 API_KEY 路径。
		vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
		vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-env");
		vi.stubEnv("ANTHROPIC_BASE_URL", "https://api.deepseek.com/anthropic");

		const modelsPath = path.join(dir, "models.json");
		const customProvidersPath = path.join(dir, "custom-providers.json");
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }, null, 2));

		const creds = new InMemoryCredentialStore();
		const mr = await ModelRuntime.create({ credentials: creds, modelsPath });
		// 真实存储在 Look 的 key（runtime source）仍然算已配置
		await mr.setRuntimeApiKey("openai", "sk-stored");
		const registry = new ModelRegistry(mr);
		const store = new CustomProvidersStore(mr, customProvidersPath);

		const result = getProviderSettings(registry, store);
		const anthropic = result.providers.find((p) => p.id === "anthropic");
		const openai = result.providers.find((p) => p.id === "openai");

		// env 来源：被视为已配置，模型列表可见，来源徽标/提示信息齐全
		expect(anthropic).toBeDefined();
		expect(anthropic!.hasKey).toBe(true);
		expect(anthropic!.modelsAvailable).toBeGreaterThan(0);
		expect(anthropic!.authSource).toBe("environment");
		expect(anthropic!.envLabel).toBe("ANTHROPIC_API_KEY");
		expect(anthropic!.envVar).toBe("ANTHROPIC_API_KEY");

		// stored/runtime 来源不受影响
		expect(openai).toBeDefined();
		expect(openai!.hasKey).toBe(true);
		expect(openai!.modelsAvailable).toBeGreaterThan(0);

		// model:list 路径同样包含 env 配置的 provider 模型
		const available = getAvailableModels(registry);
		expect(available.some((m) => m.provider === "anthropic")).toBe(true);
	});

	it("stored credential wins over env var (authSource=stored)", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-env");

		const modelsPath = path.join(dir, "models.json");
		const customProvidersPath = path.join(dir, "custom-providers.json");
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }, null, 2));

		const creds = new InMemoryCredentialStore();
		await creds.modify("openai", async () => ({ type: "api_key", key: "sk-stored" }));
		const mr = await ModelRuntime.create({ credentials: creds, modelsPath });
		const registry = new ModelRegistry(mr);
		const store = new CustomProvidersStore(mr, customProvidersPath);

		const result = getProviderSettings(registry, store);
		const openai = result.providers.find((p) => p.id === "openai");

		expect(openai?.hasKey).toBe(true);
		expect(openai?.authSource).toBe("stored");
	});
});
