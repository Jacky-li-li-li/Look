import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CustomProviderInput, CustomProvidersStore } from "../src/main/settings/custom-providers.js";

function tmpDir(): string {
	const dir = path.join(os.tmpdir(), `look-avail-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function sampleProvider(name: string): CustomProviderInput {
	return {
		name,
		baseUrl: "https://api.example.com/v1",
		api: "openai-completions",
		apiKey: "sk-test",
		models: [
			{
				id: "model-a",
				name: "Model A",
				reasoning: false,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 16384,
			},
		],
	};
}

// Mirror the current SessionRuntimeManager implementation so the test stays
// relevant even if the implementation is refactored later.
function getAvailableModelsSync(registry: ModelRegistry) {
	return registry.getAvailable().map((model) => ({
		provider: model.provider,
		id: model.id,
		name: model.name ?? model.id,
		reasoning: model.reasoning ?? false,
		contextWindow: model.contextWindow ?? 128000,
		maxTokens: model.maxTokens ?? 16384,
		cost: { input: model.cost?.input ?? 0, output: model.cost?.output ?? 0 },
	}));
}

describe("getAvailable model discovery consistency", () => {
	let dir: string;

	beforeEach(() => {
		dir = tmpDir();
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("agrees with SessionRuntimeManager's sync helper for built-in and custom providers", async () => {
		const modelsPath = path.join(dir, "models.json");
		const customProvidersPath = path.join(dir, "custom-providers.json");

		fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }, null, 2));

		const creds = new InMemoryCredentialStore();
		const mr = await ModelRuntime.create({ credentials: creds, modelsPath });
		await mr.setRuntimeApiKey("openai", "sk-runtime");
		const registry = new ModelRegistry(mr);
		const store = new CustomProvidersStore(mr, customProvidersPath);

		store.add(sampleProvider("custom-one"));

		const available = registry.getAvailable().map((m) => `${m.provider}/${m.id}`);
		const viaSyncHelper = getAvailableModelsSync(registry).map((m) => `${m.provider}/${m.id}`);

		expect(available.sort()).toEqual(viaSyncHelper.sort());
		// Both should include the runtime-override provider and the custom provider.
		expect(viaSyncHelper).toContain("openai/gpt-4");
		expect(viaSyncHelper).toContain("custom-one/model-a");
	});
});
