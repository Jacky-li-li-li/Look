// ============================================================
// LookIslandSettingsStore — persisted user settings
//
// Renders whether the island is enabled. Stored in its own file
// (~/.look/look-island-settings.json) so macOS-only island prefs
// never pollute the shared UserSettings schema.
// ============================================================

import fs from "node:fs";
import type { LookIslandSettings } from "@look/shared/types";
import { DEFAULT_LOOK_ISLAND_SETTINGS, normalizeLookIslandSettings } from "@look/shared/types";
import { writeJsonFile } from "../utils/atomic-writer.js";

export interface LookIslandSettingsStore {
	get(): LookIslandSettings;
	setEnabled(enabled: boolean): LookIslandSettings;
}

export function createLookIslandSettingsStore(filePath: string): LookIslandSettingsStore {
	let settings = load(filePath);

	return {
		get() {
			return settings;
		},
		setEnabled(enabled) {
			settings = { enabled };
			try {
				writeJsonFile(filePath, settings);
			} catch (error) {
				console.warn("[Look] Failed to persist Look Island settings:", error);
			}
			return settings;
		},
	};
}

function load(filePath: string): LookIslandSettings {
	try {
		if (!fs.existsSync(filePath)) return { ...DEFAULT_LOOK_ISLAND_SETTINGS };
		const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return normalizeLookIslandSettings(raw);
	} catch (error) {
		console.warn("[Look] Failed to load Look Island settings:", error);
		return { ...DEFAULT_LOOK_ISLAND_SETTINGS };
	}
}
