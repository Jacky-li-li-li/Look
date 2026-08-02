import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { DEFAULT_SESSION_NAME } from "@look/shared/session-defaults";
import type { IPermissionService, IPlanService, ISessionScopeRegistry } from "../../core/contracts.js";
import type { AutoTitleService } from "../../services/auto-title.js";
import type { SubAgentRuntimeService } from "../../services/subagent-runtime.js";
import { persistTurnDuration } from "../../services/turn-metrics.js";
import { markUsageDirty } from "../../system/usage-service.js";
import type { RuntimeRegistry } from "../runtime/runtime-registry.js";
import type { SubAgentRegistry } from "../subagent-registry.js";

export interface SessionEventEffectsOptions {
	runtimeRegistry: Pick<RuntimeRegistry, "get">;
	scopeRegistry: ISessionScopeRegistry;
	permissionService: Pick<IPermissionService, "persistIfDirty">;
	planService: Pick<IPlanService, "persistToolSnapshotIfDirty">;
	subAgentRuntimeService: Pick<SubAgentRuntimeService, "trackSubSessionMessageEnd" | "finalizeSubSession">;
	subAgentRegistry: Pick<SubAgentRegistry, "hasPending">;
	autoTitleService: Pick<AutoTitleService, "generateForFirstUserMessage">;
	emitUsageUpdated(): void;
	getStoredProjectId(sessionId: string): string | undefined;
	refreshProjectSessions(projectId: string): Promise<unknown>;
	emitSessionUpdated(sessionId: string): void;
	emitSessionList(projectId: string): void;
	emitError(error: unknown, sessionId: string): void;
}

/** Debounce window for usage:updated emits (assistant message_end can fire dozens of times per turn). */
const USAGE_EMIT_DEBOUNCE_MS = 300;

/** Owns non-rendering side effects triggered by terminal SDK session events. */
export class SessionEventEffects {
	private usageEmitTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly options: SessionEventEffectsOptions) {}

	/** Handle agent_end: persist state, record turn duration, refresh sidebar.
	 *  willRetry=true 表示本轮以可重试错误结束、SDK 将自动重试：此时不持久化
	 *  duration（本轮不完整），并保留 turnStartedAt 供真正结束的 agent_end 使用。
	 *  对齐 pi-coding-agent 规范：agent_end.willRetry 区分“失败重试”与“正常结束”。 */
	async onAgentEnd(sessionId: string, willRetry = false): Promise<void> {
		try {
			const binding = this.options.runtimeRegistry.get(sessionId)?.binding;
			if (binding?.sessionId === sessionId) {
				this.options.permissionService.persistIfDirty(sessionId, binding.sessionManager);
				this.options.planService.persistToolSnapshotIfDirty(sessionId, binding.sessionManager);
			}
			if (!willRetry) {
				this.persistTurnDurationIfPossible(sessionId);
			}
			await this.refreshAfterTurn(sessionId);
		} catch (error) {
			this.options.emitError(error, sessionId);
		}
	}

	async onMessageEnd(sessionId: string, message: AgentMessage): Promise<void> {
		if (message.role === "assistant") {
			this.options.subAgentRuntimeService.trackSubSessionMessageEnd(sessionId, message);
			if (message.stopReason === "aborted") return;
			markUsageDirty();
			this.scheduleUsageEmit();
			return;
		}
		if (message.role === "user") {
			await this.generateTitle(sessionId, message).catch((error) => {
				if (process.env.DEBUG_AUTO_TITLE === "1") {
					console.warn("[Look][autoTitle] trigger failed:", error);
				}
			});
		}
	}

	onSubSessionAgentEnd(sessionId: string): void {
		if (this.options.subAgentRegistry.hasPending(sessionId)) {
			this.options.subAgentRuntimeService.finalizeSubSession(sessionId);
		}
	}

	dispose(): void {
		if (this.usageEmitTimer) {
			clearTimeout(this.usageEmitTimer);
			this.usageEmitTimer = null;
		}
	}

	private scheduleUsageEmit(): void {
		if (this.usageEmitTimer) clearTimeout(this.usageEmitTimer);
		this.usageEmitTimer = setTimeout(() => {
			this.usageEmitTimer = null;
			this.options.emitUsageUpdated();
		}, USAGE_EMIT_DEBOUNCE_MS);
	}

	private async generateTitle(sessionId: string, userMessage: AgentMessage): Promise<void> {
		const managed = this.options.runtimeRegistry.get(sessionId);
		if (!managed) return;
		const session = managed.runtime.session;
		const currentName = session.sessionManager.getSessionName();
		const scope = this.options.scopeRegistry.get(sessionId);
		const isDefaultName = (scope?.isDefaultName ?? false) && (!currentName || currentName === DEFAULT_SESSION_NAME);
		await this.options.autoTitleService.generateForFirstUserMessage(session, userMessage, isDefaultName, sessionId);
	}

	private persistTurnDurationIfPossible(sessionId: string): void {
		const session = this.options.runtimeRegistry.get(sessionId)?.runtime.session;
		const scope = this.options.scopeRegistry.get(sessionId);
		const turnStartedAt = scope?.turnStartedAt ?? null;
		if (scope) scope.turnStartedAt = null;
		if (!session || !turnStartedAt) return;
		persistTurnDuration(session, turnStartedAt);
	}

	private async refreshAfterTurn(sessionId: string): Promise<void> {
		const projectId =
			this.options.runtimeRegistry.get(sessionId)?.projectId ?? this.options.getStoredProjectId(sessionId);
		if (!projectId) return;
		await this.options.refreshProjectSessions(projectId);
		this.options.emitSessionUpdated(sessionId);
		this.options.emitSessionList(projectId);
	}
}
