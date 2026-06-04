// ============================================================
// Look Storage — ~/.look/ path management
//
// pi SDK handles session persistence natively (SessionManager.create/open).
// We only store the lightweight agent index and user settings ourselves.
//
// Structure:
//   ~/.look/
//   ├── agents.json       → Agent index: [{ id, name, role, sessionFile }]
//   ├── auth.json         → pi AuthStorage
//   ├── models.json       → pi ModelRegistry
//   ├── settings.json     → User preferences
//   └── sessions/         → pi SessionManager auto-manages .jsonl files
// ============================================================

import os from "os";
import path from "path";
import fs from "fs";

const LOOK_DIR = path.join(os.homedir(), ".look");

// ── Top-level paths ──

export function getLookDir(): string {
  return LOOK_DIR;
}

/** Lightweight index: agent id → sessionFile mapping */
export function getAgentsIndexPath(): string {
  return path.join(LOOK_DIR, "agents.json");
}

/** API key storage (pi SDK AuthStorage) */
export function getAuthPath(): string {
  return path.join(LOOK_DIR, "auth.json");
}

/** Custom model definitions (pi SDK ModelRegistry) */
export function getModelsPath(): string {
  return path.join(LOOK_DIR, "models.json");
}

/** Application settings */
export function getSettingsPath(): string {
  return path.join(LOOK_DIR, "settings.json");
}

/** pi SDK session files directory */
export function getSessionsDir(): string {
  return path.join(LOOK_DIR, "sessions");
}

// ── Initialization ──

export function ensureLookDir(): void {
  fs.mkdirSync(getSessionsDir(), { recursive: true });
}
