// ============================================================
// RuntimePort contract checklist — documents the frozen surface a
// second adapter (e.g. Dsh) must implement. Design / prep only.
//
// Skipped so CI stays green until a real second adapter lands.
// Remove describe.skip when implementing DshAdapter (or a fake
// adapter under test) and assert each member / capability key.
// See docs/runtime-adapter.md §10.
// ============================================================

import { describe, expect, it } from "vitest";
import type { EngineCapabilities, RuntimePort } from "../src/main/runtime-port/types.js";
import { PI_ENGINE_CAPABILITIES } from "../src/main/runtime-port/types.js";

/** Required RuntimePort instance members (real names from types.ts). */
const RUNTIME_PORT_METHODS = [
	"create",
	"resume",
	"dispose",
	"send",
	"abort",
	"subscribe",
	"resolveToolApproval",
] as const satisfies ReadonlyArray<keyof RuntimePort>;

/** Required RuntimePort readonly fields. */
const RUNTIME_PORT_FIELDS = ["engineId", "capabilities"] as const satisfies ReadonlyArray<keyof RuntimePort>;

/** EngineCapabilities keys every adapter must declare explicitly. */
const ENGINE_CAPABILITY_KEYS = [
	"fork",
	"compaction",
	"skillsSlash",
	"mcp",
	"computerUse",
	"sessionTree",
] as const satisfies ReadonlyArray<keyof EngineCapabilities>;

// Skipped: documentation of the Port contract for future adapters.
// Enabling this suite requires a second RuntimePort implementation (or a
// structural fake) — do not turn it red against PiAdapter alone as "done".
describe.skip("RuntimePort contract (future second adapter)", () => {
	it("lists required Port methods for adapter authors", () => {
		expect(RUNTIME_PORT_METHODS).toEqual([
			"create",
			"resume",
			"dispose",
			"send",
			"abort",
			"subscribe",
			"resolveToolApproval",
		]);
		expect(RUNTIME_PORT_FIELDS).toEqual(["engineId", "capabilities"]);
	});

	it("lists EngineCapabilities keys that must be explicit booleans", () => {
		expect(ENGINE_CAPABILITY_KEYS).toEqual([
			"fork",
			"compaction",
			"skillsSlash",
			"mcp",
			"computerUse",
			"sessionTree",
		]);
		for (const key of ENGINE_CAPABILITY_KEYS) {
			expect(typeof PI_ENGINE_CAPABILITIES[key]).toBe("boolean");
		}
	});

	it("todo: second adapter declares engineId !== pi and honest capabilities", () => {
		// Placeholder until DshAdapter (or test double) exists.
		expect(true).toBe(true);
	});

	it("todo: second adapter maps engine events into LookSessionEvent (MainToRendererEvent)", () => {
		expect(true).toBe(true);
	});

	it("todo: composition root defaults to pi and falls back to pi on adapter failure", () => {
		expect(true).toBe(true);
	});
});

describe("RuntimePort contract catalog (always on)", () => {
	it("keeps the documented method list aligned with the RuntimePort type", () => {
		// Structural guard: if someone renames a Port method, update §10 + this list.
		const required = new Set<string>([...RUNTIME_PORT_METHODS, ...RUNTIME_PORT_FIELDS]);
		expect(required.has("create")).toBe(true);
		expect(required.has("abort")).toBe(true);
		expect(required.has("subscribe")).toBe(true);
		expect(required.has("resolveToolApproval")).toBe(true);
		expect(required.size).toBe(RUNTIME_PORT_METHODS.length + RUNTIME_PORT_FIELDS.length);
	});

	it("documents pi default capabilities as the full-feature baseline", () => {
		expect(PI_ENGINE_CAPABILITIES).toEqual({
			fork: true,
			compaction: true,
			skillsSlash: true,
			mcp: true,
			computerUse: true,
			sessionTree: true,
		});
	});
});
