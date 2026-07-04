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

import type { AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { IEventBus, ISessionScope, ISessionScopeRegistry } from "../core/contracts.js";
import { createContentBlockTracker, translateAgentSessionEvent } from "./event-translator.js";
import type { LookUiEvent } from "../shared/types.js";
import { UIEventBatcher } from "./ui-event-batcher.js";

/**
 * Callbacks that the event processor needs from its host (SRT).
 * Each callback corresponds to a side-effect that was previously
 * inlined in the giant handleSessionEvent switch.
 */
export interface ISessionEventHost {
	onAgentEnd(sessionId: string, willRetry: boolean): Promise<void>;
	onAgentStart(sessionId: string): number;
	onMessageEnd(sessionId: string, message: AgentMessage): Promise<void>;
	onSubSessionAgentEnd(sessionId: string): void;
	emitSessionUpdated(sessionId: string): void;
	emitSessionState(sessionId: string, reason: string): void;
}

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
	handle(sessionId: string, event: AgentSessionEvent): void {
		const scope = this.scopeRegistry.get(sessionId);
		if (!scope) return;

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
				this.eventBus.emit({ type: "session:ui-event", sessionId, events: uiEvents });
			} else {
				this.uiBatcher.bufferUiEvents(scope, uiEvents);
			}
		}

		// 3. Side-effect dispatch
		switch (event.type) {
			case "agent_end":
				scope.streamingState = event.willRetry ? "retrying" : "idle";
				this.host.emitSessionState(sessionId, "agent_end");
				this.host.onAgentEnd(sessionId, event.willRetry).catch(() => {});
				if (!event.willRetry) this.host.onSubSessionAgentEnd(sessionId);
				break;
			case "agent_start":
				scope.streamingState = "streaming";
				scope.turnStartedAt = this.host.onAgentStart(sessionId);
				this.host.emitSessionUpdated(sessionId);
				break;
			case "message_end":
				this.host.onMessageEnd(sessionId, event.message).catch(() => {});
				break;
			case "thinking_level_changed":
			case "session_info_changed":
			case "compaction_start":
			case "tool_execution_end":
				this.host.emitSessionUpdated(sessionId);
				break;
			case "compaction_end":
				this.host.emitSessionState(sessionId, "agent_end");
				this.host.emitSessionUpdated(sessionId);
				break;
			case "auto_retry_start":
			case "auto_retry_end":
				if (event.type === "auto_retry_end" && !event.success) {
					scope.streamingState = "idle";
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
