import {
	clampThinkingLevel as piClampThinkingLevel,
	getSupportedThinkingLevels as piGetSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { LookModelRef } from "../src/main/runtime-port/look-types.js";
import { clampThinkingLevel, getSupportedThinkingLevels } from "../src/main/runtime-port/thinking.js";

/** Minimal pi-shaped model (ModelLookup.find returns pi Model objects at runtime). */
function model(overrides: Record<string, unknown> = {}): LookModelRef {
	return {
		id: "m1",
		name: "Model 1",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...overrides,
	} as LookModelRef;
}

describe("runtime-port thinking helpers", () => {
	it("non-reasoning model only supports off and clamps everything to off", () => {
		const m = model({ reasoning: false });
		expect(getSupportedThinkingLevels(m)).toEqual(["off"]);
		expect(clampThinkingLevel(m, "high")).toBe("off");
		expect(clampThinkingLevel(m, "off")).toBe("off");
	});

	it("reasoning model exposes the default ladder and clamps above-max levels down", () => {
		const m = model({ reasoning: true });
		expect(getSupportedThinkingLevels(m)).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(clampThinkingLevel(m, "low")).toBe("low");
		expect(clampThinkingLevel(m, "max")).toBe("high");
	});

	it("honours thinkingLevelMap null entries as unsupported", () => {
		const m = model({ reasoning: true, thinkingLevelMap: { high: null, xhigh: null, max: null } });
		expect(getSupportedThinkingLevels(m)).toEqual(["off", "minimal", "low", "medium"]);
		expect(clampThinkingLevel(m, "max")).toBe("medium");
	});

	it("is a pure pass-through to pi-ai (no behavior change at the adapter boundary)", () => {
		for (const overrides of [
			{ reasoning: false },
			{ reasoning: true },
			{ reasoning: true, thinkingLevelMap: { high: null } },
		]) {
			const m = model(overrides);
			// biome-ignore lint/suspicious/noExplicitAny: comparing against the raw pi-ai API.
			const piModel = m as any;
			expect(getSupportedThinkingLevels(m)).toEqual(piGetSupportedThinkingLevels(piModel));
			for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
				expect(clampThinkingLevel(m, level)).toBe(piClampThinkingLevel(piModel, level));
			}
		}
	});
});
