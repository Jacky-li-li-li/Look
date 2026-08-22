import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

describe("DeepSeek thinking capability", () => {
	it("built-in deepseek-v4-flash advertises reasoning and maps high/max", async () => {
		const mr = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
		const registry = new ModelRegistry(mr);
		const model = registry.find("deepseek", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(model?.reasoning).toBe(true);
		expect(model?.thinkingLevelMap).toMatchObject({
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			max: "max",
		});
		const available = getSupportedThinkingLevels(model!);
		expect(available).toEqual(["off", "low", "high", "max"]);
	});

	it("built-in deepseek-v4-pro advertises reasoning", async () => {
		const mr = await ModelRuntime.create({ credentials: new InMemoryCredentialStore() });
		const registry = new ModelRegistry(mr);
		const model = registry.find("deepseek", "deepseek-v4-pro");
		expect(model).toBeDefined();
		expect(model?.reasoning).toBe(true);
		const available = getSupportedThinkingLevels(model!);
		expect(available).toEqual(["off", "high", "max"]);
	});

	it("ModelRuntime.create with missing models.json still exposes deepseek-v4-flash", async () => {
		const dir = mkdtempSync(join(tmpdir(), "look-models-"));
		const mr = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: join(dir, "nonexistent.json"),
		});
		const registry = new ModelRegistry(mr);
		const model = registry.find("deepseek", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(model?.reasoning).toBe(true);
	});
});
