// ============================================================
// SessionHistoryService — tree navigation, labels and durable forks
//
// Keeps SessionManager tree mutations away from the runtime façade. The host
// supplies lifecycle operations, while this service owns validation and the
// all-or-cleaned-up fork transaction.
// ============================================================

import fs, { existsSync } from "node:fs";
import { type AgentSessionRuntime, SessionManager, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { ForkedSessionResult, NavigateTreeResult, SessionSnapshotEnvelope } from "@look/shared/types";
import type { ManagedRuntime } from "./runtime-registry.js";

export interface SessionHistoryHost {
	ensureRuntime(sessionId: string): Promise<ManagedRuntime>;
	createManagedRuntime(
		cwd: string,
		sessionManager: SessionManager,
		projectId: string,
		createdAt: number,
		sessionStartEvent: SessionStartEvent,
	): Promise<ManagedRuntime>;
	withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
	disposeRuntime(sessionId: string, abort?: boolean): Promise<void>;
	getRuntime(sessionId: string): AgentSessionRuntime | undefined;
	getSessionManager(sessionId: string): SessionManager | undefined;
	refreshProjectSessions(projectId: string): Promise<unknown>;
	activateForkedSession(projectId: string, sessionId: string): void;
	markSessionDefaultName(sessionId: string): void;
	emitSessionState(sessionId: string, reason: SessionSnapshotEnvelope["reason"]): void;
}

export class SessionHistoryService {
	constructor(private readonly host: SessionHistoryHost) {}

	async navigate(
		sessionId: string,
		entryId: string,
		opts?: { summarize?: boolean; customInstructions?: string; label?: string },
	): Promise<NavigateTreeResult> {
		const session = (await this.host.ensureRuntime(sessionId)).runtime.session;
		const result = await session.navigateTree(entryId, opts);
		if (!result.cancelled) this.host.emitSessionState(sessionId, "navigate");
		return result;
	}

	async fork(sessionId: string, entryId: string, opts?: { name?: string }): Promise<ForkedSessionResult> {
		return this.host.withSessionLock(sessionId, async () => {
			const managed = await this.host.ensureRuntime(sessionId);
			const sourceSession = managed.runtime.session;
			if (sourceSession.isStreaming || sourceSession.isRetrying || sourceSession.isCompacting) {
				throw new Error("Stop the session before forking");
			}
			const sourceFile = sourceSession.sessionFile;
			if (!sourceFile) throw new Error("Source session not persisted");
			if (!sourceSession.sessionManager.getEntry(entryId)) throw new Error("Invalid entry ID for forking");

			const runner = sourceSession.extensionRunner;
			if (runner.hasHandlers("session_before_fork")) {
				const hookResult = await runner.emit({ type: "session_before_fork", entryId, position: "at" as const });
				if (hookResult?.cancel === true) throw new Error("Fork was cancelled by an extension");
			}

			const forkManager = SessionManager.open(sourceFile, sourceSession.sessionManager.getSessionDir());
			let forkedPath: string | undefined;
			let forkedSessionId: string | undefined;
			try {
				forkedPath = forkManager.createBranchedSession(entryId);
				if (!forkedPath) throw new Error("Failed to create forked session");
				forkedSessionId = forkManager.getSessionId();
				const forkedManaged = await this.host.createManagedRuntime(
					forkManager.getCwd(),
					forkManager,
					managed.projectId,
					Date.now(),
					{ type: "session_start", reason: "fork", previousSessionFile: sourceFile },
				);
				const session = forkedManaged.runtime.session;
				if (opts?.name?.trim()) session.setSessionName(opts.name.trim().slice(0, 80));
				else this.host.markSessionDefaultName(session.sessionId);
				if (!session.sessionFile) throw new Error("Forked session was not persisted");
				await this.host.refreshProjectSessions(managed.projectId);
				this.host.activateForkedSession(managed.projectId, session.sessionId);
				this.host.emitSessionState(session.sessionId, "initial");
				return { agentId: session.sessionId, sessionFilePath: session.sessionFile };
			} catch (error) {
				if (forkedSessionId && this.host.getRuntime(forkedSessionId)) {
					await this.host.disposeRuntime(forkedSessionId, true);
				}
				if (forkedPath && existsSync(forkedPath)) fs.unlinkSync(forkedPath);
				throw error;
			}
		});
	}

	setEntryLabel(sessionId: string, entryId: string, label: string | null): void {
		const manager = this.host.getSessionManager(sessionId);
		if (!manager) return;
		const leaf = manager.getLeafId();
		manager.appendLabelChange(entryId, label?.trim() || undefined);
		if (leaf) manager.branch(leaf);
		else manager.resetLeaf();
		this.host.emitSessionState(sessionId, "navigate");
	}
}
