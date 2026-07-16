import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

describe("DeepSeek thinking capability", () => {
	it("built-in deepseek-v4-flash advertises reasoning and maps high/max", () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const model = registry.find("deepseek", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(model?.reasoning).toBe(true);
		expect(model?.thinkingLevelMap).toMatchObject({
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			max: "max",
		});
		const available = getSupportedThinkingLevels(model!);
		expect(available).toEqual(["off", "high", "max"]);
	});

	it("built-in deepseek-v4-pro advertises reasoning", () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const model = registry.find("deepseek", "deepseek-v4-pro");
		expect(model).toBeDefined();
		expect(model?.reasoning).toBe(true);
		const available = getSupportedThinkingLevels(model!);
		expect(available).toEqual(["off", "high", "max"]);
	});

	it("ModelRegistry.create with missing models.json still exposes deepseek-v4-flash", () => {
		const dir = mkdtempSync(join(tmpdir(), "look-models-"));
		const registry = ModelRegistry.create(AuthStorage.inMemory(), join(dir, "nonexistent.json"));
		const model = registry.find("deepseek", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(model?.reasoning).toBe(true);
	});
});
