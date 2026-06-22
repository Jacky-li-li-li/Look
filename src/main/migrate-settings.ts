// ============================================================
// migrate-settings.ts — One-shot legacy settings migration
//
// Before the SDK-settings refactor, `UserSettingsStore` wrote a
// single `~/.look/settings.json` of its own shape:
//   { language, defaultThinkingLevel, autoCollapse,
//     autoCompress, compressThreshold, preferredModel }
//
// After the refactor, the file is owned by the SDK's
// `SettingsManager` and only persists its schema fields
// (defaultProvider, defaultModel). The
// Look-only fields (language, autoCollapse, autoCompress,
// compressThreshold) ride in a sibling `~/.look/ui-settings.json`
// managed by `UserSettingsStore` itself.
//
// This module splits the legacy file in place: the SDK-relevant
// fields stay in `settings.json`, the UI fields move to
// `ui-settings.json`. Runs once and stamps `_migrated: true` so
// subsequent boots are a no-op.
//
// Invoked synchronously from the SessionRuntimeManager constructor, BEFORE
// `SettingsManager.create()`, so the SDK reads the post-migration
// `settings.json` directly into its in-memory state — no reload
// needed.
// ============================================================

import fs from "fs";
import path from "path";
import { getSettingsPath, getUiSettingsPath } from "./shared/look-storage.js";

/** Legacy field names that move from settings.json → ui-settings.json. */
const LEGACY_UI_FIELD_RENAMES: ReadonlyArray<readonly [string, string]> = [
	["language", "language"],
	["autoCollapse", "autoCollapse"],
	["autoCompress", "autoCompress"],
	["compressThreshold", "compressThreshold"],
];

export interface MigrationResult {
	/** True if this run actually rewrote either file. */
	migrated: boolean;
	/** Human-readable list of which fields moved where, e.g.
	 *  `"language → ui-settings.json"`. Empty when nothing changed. */
	keys: string[];
}

export function migrateLegacySettings(): MigrationResult {
	const filePath = getSettingsPath();
	if (!fs.existsSync(filePath)) return { migrated: false, keys: [] };

	let data: Record<string, unknown>;
	try {
		data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		// Corrupt JSON — leave it alone, SDK's SettingsManager will
		// re-read and either accept or refuse as it sees fit.
		return { migrated: false, keys: [] };
	}
	if (typeof data !== "object" || data === null) return { migrated: false, keys: [] };

	// Already migrated? Skip.
	if (data._migrated === true) return { migrated: false, keys: [] };

	const keys: string[] = [];

	// 1) Pull UI fields out and write them to ui-settings.json. If
	//    the sibling file already has those keys, don't clobber
	//    (never overwrite a value the user set on the new schema).
	const uiOut: Record<string, unknown> = {};
	if (fs.existsSync(getUiSettingsPath())) {
		try {
			Object.assign(uiOut, JSON.parse(fs.readFileSync(getUiSettingsPath(), "utf-8")));
		} catch {
			/* corrupt — overwrite with our values below */
		}
	}
	for (const [oldKey, newKey] of LEGACY_UI_FIELD_RENAMES) {
		if (oldKey in data) {
			const value = data[oldKey];
			if (!(newKey in uiOut) && value !== undefined) {
				uiOut[newKey] = value;
				keys.push(`${oldKey} → ui-settings.json`);
			}
			delete data[oldKey];
		}
	}

	// 2) `preferredModel: "provider/modelId"` → split into the SDK
	//    pair `defaultProvider` + `defaultModel`. A null preferredModel
	//    means "no preference" — clear both halves.
	if ("preferredModel" in data) {
		const pm = data.preferredModel;
		if (typeof pm === "string" && pm.includes("/")) {
			const [provider, ...parts] = pm.split("/");
			if (provider) {
				if (!("defaultProvider" in data)) {
					data.defaultProvider = provider;
					keys.push(`preferredModel → defaultProvider`);
				}
				if (!("defaultModel" in data)) {
					data.defaultModel = parts.join("/");
					keys.push(`preferredModel → defaultModel`);
				}
			}
		} else {
			if (!("defaultProvider" in data)) data.defaultProvider = "";
			if (!("defaultModel" in data)) data.defaultModel = "";
		}
		delete data.preferredModel;
	}

	// 3) Look no longer exposes a default thinking setting. Drop the
	//    legacy field instead of carrying it into the SDK settings file.
	if ("defaultThinkingLevel" in data) {
		delete data.defaultThinkingLevel;
		keys.push(`defaultThinkingLevel removed`);
	}

	// 4) Always stamp the migration marker so we don't re-scan
	//    next boot. Keeping the marker unconditional (even with
	//    `keys.length === 0`) also means a fresh install with no
	//    legacy fields is a one-shot no-op forever.
	data._migrated = true;
	if (keys.length > 0) {
		data._migratedAt = new Date().toISOString();
	}

	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
	} catch (err) {
		console.error("[Look] Failed to write migrated settings.json:", err);
		return { migrated: false, keys: [] };
	}
	if (Object.keys(uiOut).length > 0) {
		try {
			fs.mkdirSync(path.dirname(getUiSettingsPath()), { recursive: true });
			fs.writeFileSync(getUiSettingsPath(), JSON.stringify(uiOut, null, 2));
		} catch (err) {
			console.error("[Look] Failed to write ui-settings.json:", err);
		}
	}

	return { migrated: true, keys };
}
