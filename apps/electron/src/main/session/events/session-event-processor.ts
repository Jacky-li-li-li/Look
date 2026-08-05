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
				// agent_end 只做副作用（持久化权限/计划/duration），不发快照。
				// SDK 在 agent_end 之后还要执行 compaction 判定、排队消息续跑、
				// retry 准备 — _isAgentRunActive 仍为 true，session 状态未最终确定。
				// 终态快照由 agent_settled 统一发出，保证 isStreaming=false、
				// entries 包含延迟 bash 消息等全部数据。
				await this.host.onAgentEnd(sessionId, event.willRetry);
				if (!event.willRetry) this.host.onSubSessionAgentEnd(sessionId);
				break;
			case "agent_settled":
				// SDK 已真正空闲（_isAgentRunActive=false，所有 compaction/retry/
				// 排队消息续跑均已完成）。这是每轮 turn 唯一的终态快照发射点。
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
				// willRetry: SDK 将用 compacted context 重试 → 立即快照反映压缩后状态。
				// !willRetry: agent_settled 紧随其后发终态快照，此处无需重复。
				if (event.willRetry) {
					this.host.emitSessionState(sessionId, "compaction_end");
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
