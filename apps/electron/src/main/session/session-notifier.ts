// ============================================================
// SessionNotifier — renderer-facing session projections and notifications
//
// Converts runtime/session state into MainToRendererEvent payloads. It does
// not mutate runtime state or own subscriptions; transport is supplied through
// IEventBus and all data is read through a narrow query port.
// ============================================================

import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import type { ProjectInfo, SessionSnapshotEnvelope } from "@look/shared/types";
import type { IEventBus } from "../core/contracts.js";
import type { ManagedRuntime } from "./runtime-registry.js";
import type { SessionInfoService } from "./session-info-service.js";
import { parseTodoFile } from "./todo-parser.js";

export interface SessionNotifierQueries {
	sessionInfoService: SessionInfoService;
	listProjects(): ProjectInfo[];
	getActiveProjectId(): string | null;
}

export class SessionNotifier {
	private readonly contextUsageLastEmit = new Map<string, number>();

	constructor(
		private readonly eventBus: IEventBus,
		private readonly queries: SessionNotifierQueries,
	) {}

	emitSessionState(sessionId: string | null, reason: SessionSnapshotEnvelope["reason"], willRetry?: boolean): void {
		if (!sessionId) return;
		const info = this.queries.sessionInfoService.getAgentInfo(sessionId);
		const projectId = info?.projectId;
		if (projectId) this.emitSessionList(projectId);
		const managed = this.getManagedRuntime(sessionId);
		if (managed) {
			const session = managed.runtime.session;
			const allEntries = session.sessionManager.getBranch();
			const leafId = session.sessionManager.getLeafId();
			const runtime = {
				model: session.model,
				thinkingLevel: session.thinkingLevel,
				isStreaming: willRetry !== undefined ? willRetry : (info?.isStreaming ?? session.isStreaming),
				isRetrying: session.isRetrying,
				isCompacting: session.isCompacting,
				retryAttempt: session.retryAttempt,
				steering: session.getSteeringMessages(),
				followUp: session.getFollowUpMessages(),
				stats: session.getSessionStats(),
				contextUsage: session.getContextUsage(),
			};

			// On activation, send the most recent messages first so the chat area
			// renders quickly, then follow up with the full history.
			const PARTIAL_SIZE = 100;
			const usePartial = reason === "activate" && allEntries.length > PARTIAL_SIZE;
			const entries = usePartial ? allEntries.slice(-PARTIAL_SIZE) : allEntries;
			this.eventBus.emit({
				type: "session:snapshot",
				sessionId,
				reason,
				partial: usePartial,
				leafId,
				entries,
				runtime,
			});
			if (usePartial) {
				setImmediate(() => {
					this.eventBus.emit({
						type: "session:snapshot",
						sessionId,
						reason,
						leafId,
						entries: allEntries,
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
	emit(event: import("@look/shared/types").MainToRendererEvent): void {
		this.eventBus.emit(event);
	}

	emitContextUsage(sessionId: string): void {
		const now = Date.now();
		const last = this.contextUsageLastEmit.get(sessionId) ?? 0;
		if (now - last < 500) return;
		this.contextUsageLastEmit.set(sessionId, now);
		const managed = this.getManagedRuntime(sessionId);
		if (!managed) return;
		this.eventBus.emit({
			type: "agent:context-usage",
			agentId: sessionId,
			contextUsage: managed.runtime.session.getContextUsage() as ContextUsage,
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
