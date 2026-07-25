import { describe, expect, it } from "vitest";
import { areAutoUpdatesEnabled } from "../src/main/system/updater.js";

describe("update policy", () => {
	it("enables automatic updates for COS-backed builds", () => {
		expect(areAutoUpdatesEnabled({})).toBe(true);
	});

	it("stays enabled regardless of env vars", () => {
		expect(areAutoUpdatesEnabled({ LOOK_ENABLE_AUTO_UPDATES: "false" })).toBe(true);
	});
});
