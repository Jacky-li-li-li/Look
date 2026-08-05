// ============================================================
// SessionEventProcessor — translates pi SDK events into Look UI events
//
// Extracted from SessionRuntimeManager. Receives raw AgentSessionEvent
// from the SDK subscription and:
//   1. Translates them to discrete LookUiEvent via session-event-translator
//   2. Batches non-terminal UI events through UIEventBatcher
//   3. Delegates side-effect decisions (permission persist, title trigger,
//      sub-session finalize, state updates) to the host via ISessionEventHost
// ============================================================

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { IEventBus, ISessionEventHost, ISessionScopeRegistry } from "../../core/contracts.js";
import { translateAgentSessionEvent } from "./event-translator.js";
import { UIEventBatcher } from "./ui-event-batcher.js";

export class SessionEventProcessor {
	private readonly uiBatcher: UIEventBatcher;

	constructor(
		private readonly eventBus: IEventBus,
		private readonly scopeRegistry: ISessionScopeRegistry,
		private readonly host: ISessionEventHost,
	) {
		this.uiBatcher = new UIEventBatcher(eventBus);
	}

	/** Main entry point. Called from the SDK's session.subscribe callback. */
	async handle(sessionId: string, event: AgentSessionEvent): Promise<void> {
		const scope = this.scopeRegistry.get(sessionId);
		if (!scope) {
			// scope 可能在 disposeRuntime 中被释放，但 SDK 仍有残余事件到达。
			// 此时安全忽略：运行时已销毁，persist/title/finalize 等副作用无需执行。
			if (process.env.NODE_ENV === "development") {
				console.warn(`[Look][EventProcessor] scope not found for ${sessionId.slice(0, 6)}, dropping ${event.type}`);
			}
			return;
		}

		// 1. Translate SDK event → LookUiEvent set
		const uiEvents = translateAgentSessionEvent(event, scope.translationTracker);

		// 2. Terminal events flush immediately
		const isTerminal =
			event.type === "agent_end" ||
			event.type === "compaction_end" ||
			(event.type === "auto_retry_end" && !event.success);

		if (uiEvents.length > 0) {
			if (isTerminal) {
				this.uiBatcher.flushUiEventBuffer(scope);
				this.eventBus.emit({
					type: "session:ui-event",
					sessionId,
					events: uiEvents,
				});
			} else {
				this.uiBatcher.bufferUiEvents(scope, uiEvents);
			}
		}

		// 3. Side-effect dispatch
		switch (event.type) {
			case "agent_end":
				// 正向时序：先完成 turn 收尾（持久化权限/计划状态与 duration 时长），
				// 再发 agent_end 快照——保证快照 entries 已包含本轮 duration custom entry，
				// 渲染端一次拿到时长，无需事后补发。注意 agent_end 并不代表 SDK 已空闲：
				// compaction 判定/排队消息续跑/retry 准备都在 agent_end 之后才执行，
				// 快照的 runtime.isStreaming 会如实反映（仍为 true），
				// 真正的终态由 agent_settled 快照通知（见下）。
				await this.host.onAgentEnd(sessionId, event.willRetry);
				this.host.emitSessionState(sessionId, "agent_end");
				if (!event.willRetry) this.host.onSubSessionAgentEnd(sessionId);
				break;
			case "agent_settled":
				// SDK 已真正空闲（_isAgentRunActive=false）——这是唯一的"turn 彻底结束"
				// 信号。重发终态快照：isStreaming 如实为 false，渲染端据此进入 idle。
				this.host.emitSessionState(sessionId, "agent_end");
				break;
			case "agent_start":
				scope.turnStartedAt = Date.now();
				this.host.emitSessionUpdated(sessionId);
				break;
			case "message_end":
				this.host.onMessageEnd(sessionId, event.message);
				break;
			case "message_update":
				this.host.emitContextUsage(sessionId);
				break;
			case "compaction_start":
				// Emit snapshot so sessionState.runtime.isCompacting is the single source of truth.
				this.host.emitSessionState(sessionId, "activate");
				this.host.emitSessionUpdated(sessionId);
				this.host.emitTodoUpdate(sessionId);
				break;
			case "thinking_level_changed":
			case "session_info_changed":
			case "tool_execution_end":
				this.host.emitSessionUpdated(sessionId);
				this.host.emitTodoUpdate(sessionId);
				break;
			case "compaction_end":
				if (event.willRetry) {
					this.host.emitSessionState(sessionId, "compaction_end");
				} else {
					this.host.emitSessionState(sessionId, "agent_end");
				}
				this.host.emitTodoUpdate(sessionId);
				break;
			case "auto_retry_start":
			case "auto_retry_end":
				if (event.type === "auto_retry_end" && !event.success) {
					this.host.onSubSessionAgentEnd(sessionId);
				}
				this.host.emitSessionUpdated(sessionId);
				break;
		}
	}

	/** Clean up buffered UI events for a disposed session. */
	dispose(sessionId: string): void {
		const scope = this.scopeRegistry.get(sessionId);
		if (scope) this.uiBatcher.clearUiEventBuffer(scope);
	}
}
