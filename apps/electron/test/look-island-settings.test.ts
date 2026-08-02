import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLookIslandSettingsStore } from "../src/main/look-island/settings.js";

describe("LookIslandSettingsStore", () => {
	it("defaults to disabled", () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "look-island-settings-")), "settings.json");
		const store = createLookIslandSettingsStore(file);
		expect(store.get()).toEqual({ enabled: false });
	});

	it("persists enabled and reloads", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "look-island-settings-"));
		const file = path.join(dir, "settings.json");
		const store = createLookIslandSettingsStore(file);
		store.setEnabled(true);
		expect(store.get()).toEqual({ enabled: true });

		const reloaded = createLookIslandSettingsStore(file);
		expect(reloaded.get()).toEqual({ enabled: true });
	});

	it("toggles back to disabled", () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "look-island-settings-")), "settings.json");
		const store = createLookIslandSettingsStore(file);
		store.setEnabled(true);
		store.setEnabled(false);
		expect(store.get()).toEqual({ enabled: false });
	});
});
