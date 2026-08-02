import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLookIslandLayoutStore } from "../src/main/look-island/layout-store.js";

describe("LookIslandLayoutStore", () => {
	it("returns null for unknown displays", () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "look-island-layout-")), "layout.json");
		const store = createLookIslandLayoutStore(file);
		expect(store.getForDisplay(42)).toBeNull();
	});

	it("persists and reloads per-display preferences", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "look-island-layout-"));
		const file = path.join(dir, "layout.json");
		const store = createLookIslandLayoutStore(file);
		store.updateForDisplay(1, { centerXRatio: 0.25, compactContentWidth: 264 });
		expect(store.getForDisplay(1)).toMatchObject({ centerXRatio: 0.25, compactContentWidth: 264 });

		const reloaded = createLookIslandLayoutStore(file);
		expect(reloaded.getForDisplay(1)).toMatchObject({ centerXRatio: 0.25, compactContentWidth: 264 });
	});

	it("merges partial updates without clobbering existing fields", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "look-island-layout-"));
		const file = path.join(dir, "layout.json");
		const store = createLookIslandLayoutStore(file);
		store.updateForDisplay(1, { centerXRatio: 0.5, compactContentWidth: 264 });
		store.updateForDisplay(1, { expandedContentWidth: 720 });
		const pref = store.getForDisplay(1);
		expect(pref?.centerXRatio).toBe(0.5);
		expect(pref?.compactContentWidth).toBe(264);
		expect(pref?.expandedContentWidth).toBe(720);
	});

	it("stores preferences for independent displays", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "look-island-layout-"));
		const file = path.join(dir, "layout.json");
		const store = createLookIslandLayoutStore(file);
		store.updateForDisplay(1, { centerXRatio: 0.2 });
		store.updateForDisplay(2, { centerXRatio: 0.8 });
		expect(store.getForDisplay(1)?.centerXRatio).toBe(0.2);
		expect(store.getForDisplay(2)?.centerXRatio).toBe(0.8);
	});
});
