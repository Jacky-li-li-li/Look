// ============================================================
// Pi session persistence ops — the ONLY place session/services may
// reach SessionManager construction/list/fork helpers through.
// Keeps @earendil-works/pi-coding-agent imports out of Session*Service.
// ============================================================

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { EngineSessionHandle, PersistedSessionRow } from "./look-types.js";

export function createEngineSession(cwd: string, sessionDir: string, options?: { id?: string }): EngineSessionHandle {
	return SessionManager.create(cwd, sessionDir, options);
}

export function openEngineSession(path: string, sessionDir?: string): EngineSessionHandle {
	return sessionDir === undefined ? SessionManager.open(path) : SessionManager.open(path, sessionDir);
}

/**
 * Fork helper: open an independent SessionManager on the source file
 * (never branch on the source session's live manager).
 */
export function openEngineSessionForFork(sourceFile: string, sessionDir: string): EngineSessionHandle {
	return SessionManager.open(sourceFile, sessionDir);
}

export async function listEngineSessions(cwd: string, sessionsDir: string): Promise<PersistedSessionRow[]> {
	const rows = await SessionManager.list(cwd, sessionsDir);
	return rows.map((session) => ({
		path: session.path,
		id: session.id,
		cwd: session.cwd,
		name: session.name,
		parentSessionPath: session.parentSessionPath,
		created: session.created,
		modified: session.modified,
		messageCount: session.messageCount,
		firstMessage: session.firstMessage,
		allMessagesText: session.allMessagesText,
	}));
}

export function engineSessionId(handle: EngineSessionHandle): string {
	return (handle as SessionManager).getSessionId();
}

export function engineSessionCwd(handle: EngineSessionHandle): string {
	return (handle as SessionManager).getCwd();
}

export function engineSessionDir(handle: EngineSessionHandle): string {
	return (handle as SessionManager).getSessionDir();
}

export function createBranchedEngineSession(handle: EngineSessionHandle, entryId: string): string | undefined {
	return (handle as SessionManager).createBranchedSession(entryId);
}

/** Narrow cast for composition → coordinator (still pi SessionManager at runtime). */
export function asPiSessionManager(handle: EngineSessionHandle): SessionManager {
	return handle as SessionManager;
}
