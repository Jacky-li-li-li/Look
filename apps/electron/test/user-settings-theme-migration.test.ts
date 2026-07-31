import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserSettingsStore } from "../src/main/settings/store";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

function settingsManager() {
	return {
		getDefaultProvider: () => undefined,
		getDefaultModel: () => undefined,
		setDefaultModelAndProvider: vi.fn(),
		setDefaultProvider: vi.fn(),
		setDefaultModel: vi.fn(),
		getCompactionEnabled: () => true,
		setCompactionEnabled: vi.fn(),
		getCompactionReserveTokens: () => 16384,
		getCompactionKeepRecentTokens: () => 20000,
		flush: vi.fn(async () => {}),
	};
}

describe("UserSettingsStore theme migration", () => {
	it("strips the retired style while preserving a valid light/dark preference", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "look-theme-migration-"));
		tempDirectories.push(directory);
		const settingsPath = path.join(directory, "ui-settings.json");
		fs.writeFileSync(settingsPath, JSON.stringify({ themeStyle: "field", themeTone: "light" }));

		const store = new UserSettingsStore(settingsManager() as never, settingsPath);
		const persisted = JSON.parse(fs.readFileSync(settingsPath, "utf8"));

		expect(store.getAll().themeTone).toBe("light");
		expect("themeStyle" in store.getAll()).toBe(false);
		expect(persisted.themeStyle).toBeUndefined();
		expect(persisted.themeTone).toBe("light");
	});

	it("normalizes an invalid persisted tone to the dark default", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "look-theme-migration-"));
		tempDirectories.push(directory);
		const settingsPath = path.join(directory, "ui-settings.json");
		fs.writeFileSync(settingsPath, JSON.stringify({ themeTone: "system" }));

		const store = new UserSettingsStore(settingsManager() as never, settingsPath);

		expect(store.getAll().themeTone).toBe("dark");
		expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).themeTone).toBe("dark");
	});
});
