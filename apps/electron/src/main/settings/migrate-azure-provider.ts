// ============================================================
// migrate-azure-provider.ts — pi 1.0.3 provider id rename
//
// pi renamed `azure-openai-responses` → `azure` (auth.json key,
// models.json providers key, settings.json defaultProvider /
// enabledModels / modelThinkingLevels, and session JSONL
// model_change / usage `provider` fields). Look stores these
// under LOOK_HOME; migrate once on boot so existing Azure keys,
// defaults, and session resume keep working without a manual
// /login. Nested `api: "azure-openai-responses"` is an API type,
// NOT a provider id — leave it alone.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { getAuthPath, getModelsPath, getSettingsPath, getWorkspacesDir } from "@look/shared/look-storage";
import { writeTextFile } from "../utils/atomic-writer.js";

const OLD_ID = "azure-openai-responses";
const NEW_ID = "azure";

/** Session JSONL entry types whose top-level `provider` is a provider id. */
const SESSION_PROVIDER_ENTRY_TYPES = new Set(["model_change", "usage"]);

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

/**
 * Remap top-level provider id on session JSONL entries.
 * Never touches nested `api` (API type, still azure-openai-responses).
 */
export function remapSessionEntryProvider(entry: Record<string, unknown>): boolean {
	const type = entry.type;
	if (typeof type !== "string" || !SESSION_PROVIDER_ENTRY_TYPES.has(type)) return false;
	if (entry.provider !== OLD_ID) return false;
	entry.provider = NEW_ID;
	return true;
}

/** Rewrite one JSONL session file in place when it stores the old provider id. */
export function migrateAzureProviderInSessionFile(filePath: string): boolean {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		return false;
	}
	if (!raw.includes(OLD_ID)) return false;

	const lines = raw.split("\n");
	let changed = false;
	const nextLines = lines.map((line) => {
		if (!line.trim() || !line.includes(OLD_ID)) return line;
		try {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return line;
			const entry = parsed as Record<string, unknown>;
			if (!remapSessionEntryProvider(entry)) return line;
			changed = true;
			return JSON.stringify(entry);
		} catch {
			return line;
		}
	});

	if (!changed) return false;
	// split/join preserves whether the source ended with a trailing newline.
	writeTextFile(filePath, nextLines.join("\n"));
	return true;
}

function listSessionJsonlFiles(): string[] {
	const workspacesDir = getWorkspacesDir();
	if (!fs.existsSync(workspacesDir)) return [];

	const files: string[] = [];
	let projectDirs: string[];
	try {
		projectDirs = fs.readdirSync(workspacesDir);
	} catch {
		return [];
	}

	for (const projectId of projectDirs) {
		const projectRoot = path.join(workspacesDir, projectId);
		let isDir = false;
		try {
			isDir = fs.statSync(projectRoot).isDirectory();
		} catch {
			continue;
		}
		if (!isDir) continue;

		for (const sub of ["sessions", "subsessions"]) {
			const dir = path.join(projectRoot, sub);
			if (!fs.existsSync(dir)) continue;
			let names: string[];
			try {
				names = fs.readdirSync(dir);
			} catch {
				continue;
			}
			for (const name of names) {
				if (!name.endsWith(".jsonl")) continue;
				files.push(path.join(dir, name));
			}
		}
	}
	return files;
}

function migrateSessionFiles(keys: string[]): void {
	let count = 0;
	for (const filePath of listSessionJsonlFiles()) {
		if (migrateAzureProviderInSessionFile(filePath)) count += 1;
	}
	if (count > 0) {
		keys.push(`session jsonl provider ${OLD_ID} → ${NEW_ID} (${count} file${count === 1 ? "" : "s"})`);
	}
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

	migrateSessionFiles(keys);

	return { migrated: keys.length > 0, keys };
}
