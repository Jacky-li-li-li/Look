import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("DeepSeek thinking capability", () => {
	it("built-in deepseek-v4-flash advertises reasoning and maps high/xhigh", () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const model = registry.find("deepseek", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(model?.reasoning).toBe(true);
		expect(model?.thinkingLevelMap).toMatchObject({
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: "max",
		});
		const available = getSupportedThinkingLevels(model!);
		expect(available).toEqual(["off", "high", "xhigh"]);
	});

	it("built-in deepseek-v4-pro advertises reasoning", () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const model = registry.find("deepseek", "deepseek-v4-pro");
		expect(model).toBeDefined();
		expect(model?.reasoning).toBe(true);
		const available = getSupportedThinkingLevels(model!);
		expect(available).toEqual(["off", "high", "xhigh"]);
	});

	it("ModelRegistry.create with missing models.json still exposes deepseek-v4-flash", () => {
		const dir = mkdtempSync(join(tmpdir(), "look-models-"));
		const registry = ModelRegistry.create(AuthStorage.inMemory(), join(dir, "nonexistent.json"));
		const model = registry.find("deepseek", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(model?.reasoning).toBe(true);
	});
});
