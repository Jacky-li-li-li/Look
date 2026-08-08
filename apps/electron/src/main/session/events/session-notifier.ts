// ============================================================
// SessionNotifier — renderer-facing session projections and notifications
//
// Converts runtime/session state into MainToRendererEvent payloads. It does
// not mutate runtime state or own subscriptions; transport is supplied through
// IEventBus and all data is read through a narrow query port.
// ============================================================

import type {
	MainToRendererEvent,
	ProjectInfo,
	SessionHistoryPreviewEnvelope,
	SessionHistoryWindow,
	SessionSnapshotEnvelope,
} from "@look/shared/types";
import type { IEventBus, ISessionScopeRegistry } from "../../core/contracts.js";
import type { ManagedRuntime } from "../runtime/runtime-registry.js";
import type { StoredSession } from "../services/session-catalog.js";
import { toLookSessionEntries } from "../services/session-entry-projection.js";
import { DEFAULT_HISTORY_WINDOW_SIZE, readSessionTail } from "../services/session-history-reader.js";
import type { SessionInfoService } from "../services/session-info-service.js";
import { parseTodoFile } from "../services/todo-parser.js";

const HISTORY_WINDOW_SIZE = DEFAULT_HISTORY_WINDOW_SIZE;

function historyWindow(
	entriesLength: number,
	entries: readonly { id: string }[],
	leafId: string | null,
): SessionHistoryWindow {
	return {
		cursor: entries[0]?.id ?? null,
		hasMore: entriesLength > entries.length,
		revision: leafId ?? entries.at(-1)?.id ?? "root",
	};
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

	async emitSessionPreview(sessionId: string, stored: StoredSession): Promise<void> {
		const sequence = this.nextSequence(sessionId);
		try {
			const preview = await readSessionTail(stored.path, HISTORY_WINDOW_SIZE);
			const event: SessionHistoryPreviewEnvelope = {
				type: "session:history-preview",
				sessionId,
				sequence,
				leafId: preview.leafId,
				entries: toLookSessionEntries(preview.entries),
				history: preview.history,
			};
			this.eventBus.emit(event);
		} catch (error) {
			// Preview is an optimization. Runtime activation remains authoritative.
			console.warn(`[Look][SessionNotifier] history preview failed for ${sessionId}:`, error);
		}
	}

	emitSessionState(sessionId: string | null, reason: SessionSnapshotEnvelope["reason"]): void {
		if (!sessionId) return;
		const sequence = this.nextSequence(sessionId);
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
			// isStreaming mirrors the SDK's live _isAgentRunActive. The terminal
			// snapshot is emitted on agent_settled (after _isAgentRunActive=false),
			// so isStreaming is always false at this point.
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

			// Large recovery snapshots are windowed. The renderer requests older entries
			// by cursor; sending the full branch here defeats the fast path. Navigate is
			// windowed too: after tree navigation the branch is rebuilt from disk and the
			// renderer re-paginates, avoiding a full-history broadcast on every jump.
			const windowableReason = reason === "activate" || reason === "agent_end" || reason === "navigate";
			const usePartial = windowableReason && allEntries.length > HISTORY_WINDOW_SIZE;
			const entries = usePartial ? allEntries.slice(-HISTORY_WINDOW_SIZE) : allEntries;
			const lookEntries = toLookSessionEntries(entries);
			this.eventBus.emit({
				type: "session:snapshot",
				sessionId,
				reason,
				sequence,
				partial: usePartial || undefined,
				history: usePartial ? historyWindow(allEntries.length, entries, leafId) : undefined,
				leafId,
				entries: lookEntries,
				runtime,
			});
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
		this.snapshotSequences.clear();
	}

	private nextSequence(sessionId: string): number {
		const sequence = (this.snapshotSequences.get(sessionId) ?? 0) + 1;
		this.snapshotSequences.set(sessionId, sequence);
		return sequence;
	}

	private getManagedRuntime(sessionId: string): ManagedRuntime | undefined {
		return this.queries.sessionInfoService.getManagedRuntime(sessionId);
	}
}
