// ============================================================
// Regression test: adding a custom provider must not erase
// previously configured providers from settings:get output.
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { CustomProvidersStore, type CustomProviderInput } from "../src/main/settings/custom-providers.js";

function tmpDir(): string {
	const dir = path.join(os.tmpdir(), `look-cp-bug-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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

function getAvailableModelsSync(registry: ModelRegistry) {
	return registry
		.getAll()
		.filter((model) => registry.getProviderAuthStatus(model.provider).configured)
		.map((model) => ({
			provider: model.provider,
			id: model.id,
			name: model.name ?? model.id,
			reasoning: model.reasoning ?? false,
			contextWindow: model.contextWindow ?? 128000,
			maxTokens: model.maxTokens ?? 16384,
			cost: { input: model.cost?.input ?? 0, output: model.cost?.output ?? 0 },
		}));
}

function getProviders(registry: ModelRegistry) {
	const providers = new Map<string, string>();
	for (const model of registry.getAll()) {
		providers.set(model.provider, registry.getProviderDisplayName(model.provider));
	}
	return Array.from(providers, ([id, name]) => ({
		id,
		name,
		hasCredentials: registry.getProviderAuthStatus(id).configured,
		models: registry
			.getAvailable()
			.filter((model) => model.provider === id)
			.map((model) => model.id),
	}));
}

function getProviderSettings(registry: ModelRegistry) {
	const providers = getProviders(registry);
	return providers.map((provider) => {
		const auth = registry.getProviderAuthStatus(provider.id);
		const models = getAvailableModelsSync(registry).filter((model) => model.provider === provider.id);
		return {
			id: provider.id,
			name: provider.name,
			hasKey: provider.hasCredentials,
			envVar: auth.source === "environment" ? auth.label : undefined,
			modelsAvailable: models.length,
			models,
			authSource: auth.source,
			envLabel: auth.label,
		};
	});
}

describe("Custom provider + built-in provider settings coexistence", () => {
	let dir: string;
	let authPath: string;
	let modelsPath: string;
	let customProvidersPath: string;

	beforeEach(() => {
		dir = tmpDir();
		authPath = path.join(dir, "auth.json");
		modelsPath = path.join(dir, "models.json");
		customProvidersPath = path.join(dir, "custom-providers.json");
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("keeps built-in provider models after adding a custom provider", () => {
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }, null, 2));

		const authStorage = AuthStorage.create(authPath);
		const registry = ModelRegistry.create(authStorage, modelsPath);
		const store = new CustomProvidersStore(registry, customProvidersPath);

		authStorage.set("openai", { type: "api_key", key: "sk-openai" });

		const before = getProviderSettings(registry);
		const openaiBefore = before.find((p) => p.id === "openai");
		expect(openaiBefore?.hasKey).toBe(true);
		expect(openaiBefore?.modelsAvailable).toBeGreaterThan(0);

		store.add(sampleProvider("custom-one"));

		const afterFirst = getProviderSettings(registry);
		const openaiAfterFirst = afterFirst.find((p) => p.id === "openai");
		const customOneAfterFirst = afterFirst.find((p) => p.id === "custom-one");

		expect(openaiAfterFirst?.hasKey).toBe(true);
		expect(openaiAfterFirst?.modelsAvailable).toBeGreaterThan(0);
		expect(customOneAfterFirst?.modelsAvailable).toBe(1);

		store.add(sampleProvider("custom-two"));

		const afterSecond = getProviderSettings(registry);
		const openaiAfterSecond = afterSecond.find((p) => p.id === "openai");
		const customOneAfterSecond = afterSecond.find((p) => p.id === "custom-one");
		const customTwoAfterSecond = afterSecond.find((p) => p.id === "custom-two");

		expect(openaiAfterSecond?.hasKey).toBe(true);
		expect(openaiAfterSecond?.modelsAvailable).toBeGreaterThan(0);
		expect(customOneAfterSecond?.modelsAvailable).toBe(1);
		expect(customTwoAfterSecond?.modelsAvailable).toBe(1);

		const persisted = JSON.parse(fs.readFileSync(customProvidersPath, "utf8"));
		expect(persisted.providers.map((p: CustomProviderInput) => p.name)).toEqual(["custom-one", "custom-two"]);
	});

	it("keeps previously loaded custom providers after adding a new one", () => {
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }, null, 2));

		// Simulate a previous session that persisted two custom providers.
		fs.writeFileSync(
			customProvidersPath,
			JSON.stringify({ providers: [sampleProvider("custom-one"), sampleProvider("custom-two")] }, null, 2),
		);

		const authStorage = AuthStorage.create(authPath);
		const registry = ModelRegistry.create(authStorage, modelsPath);
		const store = new CustomProvidersStore(registry, customProvidersPath);

		// Boot: load persisted custom providers.
		store.load();

		const before = getProviderSettings(registry);
		expect(before.find((p) => p.id === "custom-one")?.modelsAvailable).toBe(1);
		expect(before.find((p) => p.id === "custom-two")?.modelsAvailable).toBe(1);

		// Add a third custom provider.
		store.add(sampleProvider("custom-three"));

		const after = getProviderSettings(registry);
		expect(after.find((p) => p.id === "custom-one")?.modelsAvailable).toBe(1);
		expect(after.find((p) => p.id === "custom-two")?.modelsAvailable).toBe(1);
		expect(after.find((p) => p.id === "custom-three")?.modelsAvailable).toBe(1);

		const persisted = JSON.parse(fs.readFileSync(customProvidersPath, "utf8"));
		expect(persisted.providers.map((p: CustomProviderInput) => p.name)).toEqual([
			"custom-one",
			"custom-two",
			"custom-three",
		]);
	});
});
