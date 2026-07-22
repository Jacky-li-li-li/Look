import { describe, expect, it } from "vitest";
import { areAutoUpdatesEnabled } from "../src/main/system/updater.js";

describe("update policy", () => {
	it("keeps private release checks disabled by default", () => {
		expect(areAutoUpdatesEnabled({})).toBe(false);
	});

	it("requires an explicit runtime opt-in", () => {
		expect(areAutoUpdatesEnabled({ LOOK_ENABLE_AUTO_UPDATES: "true" })).toBe(true);
	});
});
