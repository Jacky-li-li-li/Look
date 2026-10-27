// ============================================================
// migrate-azure-provider.ts — pi 1.0.3 provider id rename
//
// pi renamed `azure-openai-responses` → `azure` (auth.json key,
// models.json providers key, settings.json defaultProvider /
// enabledModels / modelThinkingLevels). Look stores the same
// files under LOOK_HOME; migrate once on boot so existing Azure
// keys and defaults keep working without a manual /login.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { getAuthPath, getModelsPath, getSettingsPath } from "@look/shared/look-storage";

const OLD_ID = "azure-openai-responses";
const NEW_ID = "azure";

export interface AzureProviderMigrationResult {
	migrated: boolean;
	keys: string[];
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
	if (!fs.existsSync(filePath)) return null;
	try {
		const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
		if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
		return data as Record<string, unknown>;
	} catch {
		return null;
	}
}

function writeJsonObject(filePath: string, data: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function renameTopLevelKey(data: Record<string, unknown>, oldKey: string, newKey: string): boolean {
	if (!(oldKey in data)) return false;
	if (!(newKey in data)) {
		data[newKey] = data[oldKey];
	}
	delete data[oldKey];
	return true;
}

function rewriteProviderPatterns(values: unknown): { next: unknown; changed: boolean } {
	if (!Array.isArray(values)) return { next: values, changed: false };
	let changed = false;
	const next = values.map((entry) => {
		if (typeof entry !== "string") return entry;
		if (entry === OLD_ID || entry.startsWith(`${OLD_ID}/`) || entry.startsWith(`${OLD_ID}:`)) {
			changed = true;
			return `${NEW_ID}${entry.slice(OLD_ID.length)}`;
		}
		return entry;
	});
	return { next, changed };
}

function rewriteThinkingLevelKeys(values: unknown): { next: unknown; changed: boolean } {
	if (typeof values !== "object" || values === null || Array.isArray(values)) {
		return { next: values, changed: false };
	}
	const record = values as Record<string, unknown>;
	let changed = false;
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key === OLD_ID || key.startsWith(`${OLD_ID}/`)) {
			const renamed = `${NEW_ID}${key.slice(OLD_ID.length)}`;
			if (!(renamed in next)) next[renamed] = value;
			changed = true;
		} else {
			next[key] = value;
		}
	}
	return { next, changed };
}

/** Rename stored Azure provider id from azure-openai-responses → azure. */
export function migrateAzureProviderId(): AzureProviderMigrationResult {
	const keys: string[] = [];

	const authPath = getAuthPath();
	const auth = readJsonObject(authPath);
	if (auth && renameTopLevelKey(auth, OLD_ID, NEW_ID)) {
		writeJsonObject(authPath, auth);
		keys.push(`auth.json ${OLD_ID} → ${NEW_ID}`);
	}

	const modelsPath = getModelsPath();
	const models = readJsonObject(modelsPath);
	if (models) {
		const providers = models.providers;
		if (typeof providers === "object" && providers !== null && !Array.isArray(providers)) {
			const providersRecord = providers as Record<string, unknown>;
			if (renameTopLevelKey(providersRecord, OLD_ID, NEW_ID)) {
				models.providers = providersRecord;
				writeJsonObject(modelsPath, models);
				keys.push(`models.json providers.${OLD_ID} → ${NEW_ID}`);
			}
		}
	}

	const settingsPath = getSettingsPath();
	const settings = readJsonObject(settingsPath);
	if (settings) {
		let changed = false;
		if (settings.defaultProvider === OLD_ID) {
			settings.defaultProvider = NEW_ID;
			changed = true;
			keys.push(`settings.json defaultProvider ${OLD_ID} → ${NEW_ID}`);
		}
		const enabled = rewriteProviderPatterns(settings.enabledModels);
		if (enabled.changed) {
			settings.enabledModels = enabled.next;
			changed = true;
			keys.push(`settings.json enabledModels ${OLD_ID} → ${NEW_ID}`);
		}
		const thinking = rewriteThinkingLevelKeys(settings.modelThinkingLevels);
		if (thinking.changed) {
			settings.modelThinkingLevels = thinking.next;
			changed = true;
			keys.push(`settings.json modelThinkingLevels ${OLD_ID} → ${NEW_ID}`);
		}
		if (changed) writeJsonObject(settingsPath, settings);
	}

	return { migrated: keys.length > 0, keys };
}
