// ============================================================
// SessionNotifier — renderer-facing session projections and notifications
//
// Converts runtime/session state into MainToRendererEvent payloads. It does
// not mutate runtime state or own subscriptions; transport is supplied through
// IEventBus and all data is read through a narrow query port.
// ============================================================

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { LookSessionEntry, MainToRendererEvent, ProjectInfo, SessionSnapshotEnvelope } from "@look/shared/types";
import type { IEventBus, ISessionScopeRegistry } from "../../core/contracts.js";
import type { ManagedRuntime } from "../runtime/runtime-registry.js";
import type { SessionInfoService } from "../services/session-info-service.js";
import { parseTodoFile } from "../services/todo-parser.js";

/**
 * Translate pi SDK SessionEntry[] to renderer-optimized LookSessionEntry[].
 * Only fields the renderer actually uses are retained — this decouples the
 * renderer from pi SDK internals and reduces IPC payload size.
 *
 * @see ARCHITECTURE: .trae/documents/look-project-architecture-review.md #3
 */
function toLookSessionEntry(entry: SessionEntry): LookSessionEntry {
	switch (entry.type) {
		case "message":
			return { type: "message", id: entry.id, message: entry.message };
		case "compaction":
			return { type: "compaction", id: entry.id, summary: entry.summary, tokensBefore: entry.tokensBefore };
		case "branch_summary":
			return { type: "branch_summary", id: entry.id, summary: entry.summary };
		case "custom":
			return { type: "custom", id: entry.id, customType: entry.customType, data: entry.data };
		case "custom_message":
			return {
				type: "custom_message",
				id: entry.id,
				customType: entry.customType,
				content: entry.content,
				display: entry.display,
			};
		case "model_change":
			return { type: "model_change", id: entry.id, provider: entry.provider, modelId: entry.modelId };
		case "thinking_level_change":
			return { type: "thinking_level_change", id: entry.id, thinkingLevel: entry.thinkingLevel };
		case "label":
			return { type: "label", id: entry.id, label: entry.label };
		case "session_info":
			return { type: "session_info", id: entry.id, name: entry.name };
	}
}

export interface SessionNotifierQueries {
	sessionInfoService: SessionInfoService;
	scopeRegistry: Pick<ISessionScopeRegistry, "get">;
	listProjects(): ProjectInfo[];
	getActiveProjectId(): string | null;
}

export class SessionNotifier {
	private readonly contextUsageLastEmit = new Map<string, number>();
	/** Monotonic snapshot sequence per session; guards against stale deferred snapshots. */
	private readonly snapshotSequences = new Map<string, number>();

	constructor(
		private readonly eventBus: IEventBus,
		private readonly queries: SessionNotifierQueries,
	) {}

	emitSessionState(sessionId: string | null, reason: SessionSnapshotEnvelope["reason"]): void {
		if (!sessionId) return;
		const sequence = (this.snapshotSequences.get(sessionId) ?? 0) + 1;
		this.snapshotSequences.set(sessionId, sequence);
		const info = this.queries.sessionInfoService.getAgentInfo(sessionId);
		const projectId = info?.projectId;
		if (projectId) this.emitSessionList(projectId);
		const managed = this.getManagedRuntime(sessionId);
		if (managed) {
			const session = managed.runtime.session;
			const allEntries = session.sessionManager.getBranch();
			const leafId = session.sessionManager.getLeafId();
			// snapshot.runtime.isCompacting is the renderer's single truth source.
			// For compaction_end/agent_end we force false to avoid reading SDK's
			// stale isCompacting before the SDK finishes its cleanup.

			// SDK workaround: session.isCompacting may still be true when compaction_end / agent_end
			// events arrive (the SDK cleans it up asynchronously after emitting). We force it to false
			// so the renderer doesn't show a stale compacting indicator.
			// @see ARCHITECTURE: pi SDK workaround #2
			const isCompactingFinal = reason === "compaction_end" || reason === "agent_end" ? false : session.isCompacting;
			const scope = this.queries.scopeRegistry.get(sessionId);
			// isStreaming always mirrors the SDK's live state (single source of truth).
			// The SDK stays busy (session.isStreaming === true) between agent_end and the
			// final agent_settled — compaction decision, queued-message continuation and
			// retry preparation all run inside _runAgentPrompt after agent_end was emitted.
			// Reporting it truthfully keeps the UI busy through the whole turn lifecycle;
			// the terminal idle snapshot is emitted by SessionEventProcessor on
			// agent_settled, when the SDK has actually settled.
			const runtime = {
				model: session.model,
				thinkingLevel: session.thinkingLevel,
				isStreaming: session.isStreaming,
				isRetrying: session.isRetrying,
				isCompacting: isCompactingFinal,
				retryAttempt: session.retryAttempt,
				steering: session.getSteeringMessages(),
				followUp: session.getFollowUpMessages(),
				stats: session.getSessionStats(),
				contextUsage: session.getContextUsage(),
				compactionEstimatedTokensAfter: scope?.compactionEstimatedTokensAfter,
			};

			// On activation, send the most recent messages first so the chat area
			// renders quickly, then follow up with the full history. The deferred
			// full snapshot deliberately reuses the SAME sequence: the renderer
			// (snapshot.ts) drops only strictly-older sequences (`<`), so the
			// equal-sequence full snapshot is applied and replaces the partial.
			// Do NOT bump the sequence here or "fix" the renderer to `<=` —
			// that would drop the full history and leave the chat stuck at 100.
			const PARTIAL_SIZE = 100;
			const usePartial = reason === "activate" && allEntries.length > PARTIAL_SIZE;
			const entries = usePartial ? allEntries.slice(-PARTIAL_SIZE) : allEntries;
			const lookEntries = entries.map(toLookSessionEntry);
			this.eventBus.emit({
				type: "session:snapshot",
				sessionId,
				reason,
				sequence,
				partial: usePartial,
				leafId,
				entries: lookEntries,
				runtime,
			});
			if (usePartial) {
				setImmediate(() => {
					this.eventBus.emit({
						type: "session:snapshot",
						sessionId,
						reason,
						sequence,
						leafId,
						entries: allEntries.map(toLookSessionEntry),
						runtime,
					});
				});
			}
		}
		this.emitSessionUpdated(sessionId);
	}

	emitTodoUpdate(sessionId: string): void {
		const managed = this.getManagedRuntime(sessionId);
		if (!managed) return;
		this.eventBus.emit({ type: "todo:update", sessionId, items: parseTodoFile(managed.cwd) ?? [] });
	}

	emitSessionUpdated(sessionId: string): void {
		const info = this.queries.sessionInfoService.getAgentInfo(sessionId);
		if (info) this.eventBus.emit({ type: "agent:updated", agentId: info.id, agent: info });
	}

	/** Emit an arbitrary event to the renderer. Used for OAuth login prompts etc. */
	emit(event: MainToRendererEvent): void {
		this.eventBus.emit(event);
	}

	emitContextUsage(sessionId: string): void {
		const now = Date.now();
		const last = this.contextUsageLastEmit.get(sessionId) ?? 0;
		if (now - last < 500) return;
		this.contextUsageLastEmit.set(sessionId, now);
		const managed = this.getManagedRuntime(sessionId);
		if (!managed) return;
		const contextUsage = managed.runtime.session.getContextUsage();
		if (!contextUsage) return;
		this.eventBus.emit({
			type: "agent:context-usage",
			agentId: sessionId,
			contextUsage,
		});
	}

	emitSessionList(projectId: string): void {
		this.eventBus.emit({
			type: "agent:list",
			projectId,
			agents: this.queries.sessionInfoService.listAgentsInProject(projectId),
		});
	}

	emitProjectList(): void {
		this.eventBus.emit({
			type: "project:list",
			projects: this.queries.listProjects(),
			activeProjectId: this.queries.getActiveProjectId(),
		});
	}

	emitError(error: unknown, sessionId?: string): void {
		this.eventBus.emit({
			type: "error",
			agentId: sessionId,
			message: error instanceof Error ? error.message : String(error),
		});
	}

	disposeSession(sessionId: string): void {
		this.contextUsageLastEmit.delete(sessionId);
	}

	clear(): void {
		this.contextUsageLastEmit.clear();
	}

	private getManagedRuntime(sessionId: string): ManagedRuntime | undefined {
		return this.queries.sessionInfoService.getManagedRuntime(sessionId);
	}
}
