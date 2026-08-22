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
	it("replaces retired visual styles with Graphite while preserving the display mode", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "look-theme-migration-"));
		tempDirectories.push(directory);
		const settingsPath = path.join(directory, "ui-settings.json");
		fs.writeFileSync(settingsPath, JSON.stringify({ themeStyle: "field", themeTone: "light" }));

		const store = new UserSettingsStore(settingsManager() as never, settingsPath);
		const persisted = JSON.parse(fs.readFileSync(settingsPath, "utf8"));

		expect(store.getAll().themeTone).toBe("light");
		expect(store.getAll().themeStyle).toBe("graphite");
		expect(persisted.themeStyle).toBe("graphite");
		expect(persisted.themeTone).toBe("light");
	});

	it("normalizes an invalid persisted tone to the dark default", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "look-theme-migration-"));
		tempDirectories.push(directory);
		const settingsPath = path.join(directory, "ui-settings.json");
		fs.writeFileSync(settingsPath, JSON.stringify({ themeTone: "system" }));

		const store = new UserSettingsStore(settingsManager() as never, settingsPath);

		expect(store.getAll().themeTone).toBe("dark");
		expect(store.getAll().themeStyle).toBe("graphite");
		expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).themeTone).toBe("dark");
	});

	it("splits the prior composite theme value into independent settings", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "look-theme-migration-"));
		tempDirectories.push(directory);
		const settingsPath = path.join(directory, "ui-settings.json");
		fs.writeFileSync(settingsPath, JSON.stringify({ themeTone: "azure-dark" }));

		const store = new UserSettingsStore(settingsManager() as never, settingsPath);
		const persisted = JSON.parse(fs.readFileSync(settingsPath, "utf8"));

		expect(store.getAll().themeStyle).toBe("azure");
		expect(store.getAll().themeTone).toBe("dark");
		expect(persisted.themeStyle).toBe("azure");
		expect(persisted.themeTone).toBe("dark");
	});

	it("maps each retired tone onto a fixed theme and display mode", () => {
		const legacyMap = {
			"catppuccin-mocha": { themeStyle: "iris", themeTone: "dark" },
			"catppuccin-latte": { themeStyle: "iris", themeTone: "light" },
			"tokyo-night": { themeStyle: "azure", themeTone: "dark" },
			"gruvbox-dark": { themeStyle: "dune", themeTone: "dark" },
			"gruvbox-light": { themeStyle: "dune", themeTone: "light" },
			"rose-pine": { themeStyle: "iris", themeTone: "dark" },
			"rose-pine-dawn": { themeStyle: "iris", themeTone: "light" },
		};

		for (const [legacy, expected] of Object.entries(legacyMap)) {
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "look-theme-migration-"));
			tempDirectories.push(directory);
			const settingsPath = path.join(directory, "ui-settings.json");
			fs.writeFileSync(settingsPath, JSON.stringify({ themeTone: legacy }));

			const store = new UserSettingsStore(settingsManager() as never, settingsPath);

			expect(store.getAll().themeStyle, legacy).toBe(expected.themeStyle);
			expect(store.getAll().themeTone, legacy).toBe(expected.themeTone);
		}
	});

	it("keeps separately persisted themes and modes intact", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "look-theme-migration-"));
		tempDirectories.push(directory);
		const settingsPath = path.join(directory, "ui-settings.json");
		fs.writeFileSync(settingsPath, JSON.stringify({ themeStyle: "pine", themeTone: "light" }));

		const store = new UserSettingsStore(settingsManager() as never, settingsPath);

		expect(store.getAll().themeStyle).toBe("pine");
		expect(store.getAll().themeTone).toBe("light");
	});

	it("updates a fixed theme and display mode independently", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "look-theme-migration-"));
		tempDirectories.push(directory);
		const settingsPath = path.join(directory, "ui-settings.json");
		const store = new UserSettingsStore(settingsManager() as never, settingsPath);

		await store.update({ themeStyle: "azure" });
		expect(store.getAll().themeStyle).toBe("azure");
		expect(store.getAll().themeTone).toBe("dark");

		await store.update({ themeTone: "light" });
		expect(store.getAll().themeStyle).toBe("azure");
		expect(store.getAll().themeTone).toBe("light");
		expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toMatchObject({
			themeStyle: "azure",
			themeTone: "light",
		});
	});
});
