// ============================================================
// Look Storage — ~/.look/ path management
//
// pi SDK handles session persistence natively (SessionManager.create/open).
// We only store the lightweight agent index and user settings ourselves.
//
// Structure:
//   ~/.look/
//   ├── agents.json       → Agent index: [{ id, name, role, sessionFile, projectId }]
//   ├── projects.json     → Project index: [{ id, name, cwd }]
//   ├── auth.json         → pi AuthStorage
//   ├── models.json       → pi ModelRegistry
//   ├── settings.json     → User preferences
//   └── sessions/         → pi SessionManager auto-manages .jsonl files
// ============================================================

import fs from "fs";
import os from "os";
import path from "path";

const LOOK_DIR = path.join(os.homedir(), ".look");

// ── Top-level paths ──

export function getLookDir(): string {
	return LOOK_DIR;
}

/** Lightweight index: agent id → sessionFile mapping */
export function getAgentsIndexPath(): string {
	return path.join(LOOK_DIR, "agents.json");
}

/** Project index: project id → cwd mapping */
export function getProjectsIndexPath(): string {
	return path.join(LOOK_DIR, "projects.json");
}

/** API key storage (pi SDK AuthStorage) */
export function getAuthPath(): string {
	return path.join(LOOK_DIR, "auth.json");
}

/** Custom model definitions (pi SDK ModelRegistry) */
export function getModelsPath(): string {
	return path.join(LOOK_DIR, "models.json");
}

/** Application settings (owned by the SDK's SettingsManager) */
export function getSettingsPath(): string {
	return path.join(LOOK_DIR, "settings.json");
}

/** Look-only UI preferences (language, auto-collapse, auto-compress,
 *  compress threshold) — fields the SDK's settings schema doesn't
 *  carry. Persisted by `UserSettingsStore` itself, not the SDK. */
export function getUiSettingsPath(): string {
	return path.join(LOOK_DIR, "ui-settings.json");
}

/** pi SDK session files directory */
export function getSessionsDir(): string {
	return path.join(LOOK_DIR, "sessions");
}

// ── Initialization ──

export function ensureLookDir(): void {
	fs.mkdirSync(getSessionsDir(), { recursive: true });
}
