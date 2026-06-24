// ============================================================
// Look Storage — ~/.look/ path management
//
// pi SDK handles session persistence natively (SessionManager.create/open).
// Look stores project bookmarks and UI preferences; pi owns session state.
//
// Structure:
//   ~/.look/
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

/** Dynamically registered custom providers (Look-managed, persisted across restarts) */
export function getCustomProvidersPath(): string {
	return path.join(LOOK_DIR, "custom-providers.json");
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

/** User profile (avatar, display name, etc.) */
export function getUserProfilePath(): string {
	return path.join(LOOK_DIR, "user-profile.json");
}

/** pi SDK session files directory */
export function getSessionsDir(): string {
	return path.join(LOOK_DIR, "sessions");
}

/** MCP server configurations */
export function getMcpServersPath(): string {
	return path.join(LOOK_DIR, "mcp-servers.json");
}

// ── Initialization ──

export function ensureLookDir(): void {
	fs.mkdirSync(getSessionsDir(), { recursive: true });
}

/**
 * One-time destructive reset for the SDK-native message protocol migration.
 * Old sessions are intentionally not converted or retained.
 */
export function resetLegacySessionsOnce(lookDir = LOOK_DIR): void {
	const marker = path.join(lookDir, ".sdk-message-reset-v1");
	const sessionsDir = path.join(lookDir, "sessions");
	const uiSettingsPath = path.join(lookDir, "ui-settings.json");
	if (fs.existsSync(marker)) return;
	fs.mkdirSync(lookDir, { recursive: true });
	fs.rmSync(sessionsDir, { recursive: true, force: true });
	fs.mkdirSync(sessionsDir, { recursive: true });

	if (fs.existsSync(uiSettingsPath)) {
		const parsed = JSON.parse(fs.readFileSync(uiSettingsPath, "utf8"));
		parsed.lastActiveSessionId = "";
		parsed.openedSessionIds = [];
		delete parsed.lastActiveAgentId;
		const tempPath = `${uiSettingsPath}.sdk-reset.tmp`;
		fs.writeFileSync(tempPath, JSON.stringify(parsed, null, 2));
		fs.renameSync(tempPath, uiSettingsPath);
	}

	const tempMarker = `${marker}.tmp`;
	fs.writeFileSync(tempMarker, `${new Date().toISOString()}\n`);
	fs.renameSync(tempMarker, marker);
}
