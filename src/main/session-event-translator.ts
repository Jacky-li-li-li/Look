import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { LookMessageSubEvent, LookUiEvent } from "./shared/types.js";

/** Tracks active (started-but-not-ended) content blocks during streaming.
 *  Used by translateAgentSessionEvent to emit synthetic end events when
 *  the assistant stream completes or agent turn ends. */
export interface ContentBlockTracker {
	activeTextIndices: Set<number>;
	activeThinkingIndices: Set<number>;
	activeToolCallIndices: Set<number>;
}

export function createContentBlockTracker(): ContentBlockTracker {
	return {
		activeTextIndices: new Set(),
		activeThinkingIndices: new Set(),
		activeToolCallIndices: new Set(),
	};
}

/** Emit synthetic end events for any content blocks that were started but
 *  never received a corresponding end event from the assistant stream.
 *
 *  Text and thinking blocks can be closed with an empty payload because the
 *  renderer has already accumulated the live content via delta events.
 *
 *  Toolcall blocks are *not* synthesized here: the SDK always emits the real
 *  `toolcall_end` before the stream finishes. On the rare path where it does
 *  not, the renderer drops incomplete transient blocks when the run status
 *  returns to idle. */
export function finishActiveBlocks(tracker: ContentBlockTracker, events: LookUiEvent[], now: number): void {
	for (const ci of tracker.activeTextIndices) {
		events.push({ type: "assistant_text_end", contentIndex: ci, text: "", timestamp: now });
	}
	for (const ci of tracker.activeThinkingIndices) {
		events.push({ type: "thinking_end", contentIndex: ci, thinking: "", timestamp: now });
	}
	tracker.activeTextIndices.clear();
	tracker.activeThinkingIndices.clear();
	tracker.activeToolCallIndices.clear();
}

/** Extract plain-text content from a user AgentMessage. */
export function extractUserMessageText(message: AgentMessage): string {
	const msg = message as unknown as Record<string, unknown>;
	if (typeof msg.content === "string") return msg.content as string;
	if (Array.isArray(msg.content)) {
		return (msg.content as Array<Record<string, unknown>>)
			.flatMap((b) => (b.type === "text" ? [(b as { text: string }).text] : []))
			.join("\n");
	}
	return "";
}

/**
 * Translate a single AgentSessionEvent into zero or more discrete LookUiEvent items.
 *
 * Uses the fine-grained `assistantMessageEvent` sub-event on `message_update` to
 * produce delta-level events (text_delta / thinking_delta / toolcall_arg_delta)
 * instead of full message snapshots. The pi SDK already computes the deltas — we
 * simply forward them with stable `contentIndex` keys.
 */
export function translateAgentSessionEvent(event: AgentSessionEvent, tracker: ContentBlockTracker): LookUiEvent[] {
	const now = Date.now();
	const events: LookUiEvent[] = [];

	switch (event.type) {
		// ── Run lifecycle ──
		case "agent_start":
			tracker.activeTextIndices.clear();
			tracker.activeThinkingIndices.clear();
			tracker.activeToolCallIndices.clear();
			events.push({ type: "run_status", status: "streaming", timestamp: now });
			break;

		case "agent_end":
			finishActiveBlocks(tracker, events, now);
			events.push({
				type: "run_status",
				status: event.willRetry ? "retrying" : "idle",
				willRetry: event.willRetry,
				timestamp: now,
			});
			break;

		// ── Message lifecycle ──
		case "message_start": {
			const msg = event.message as unknown as Record<string, unknown>;
			if (msg.role === "user") {
				const text = extractUserMessageText(event.message);
				events.push({ type: "user_message", text, timestamp: now });
			} else if (msg.role === "assistant") {
				events.push({ type: "assistant_message_start", timestamp: now });
			}
			break;
		}

		case "message_end": {
			finishActiveBlocks(tracker, events, now);
			const msg = event.message as unknown as Record<string, unknown>;
			const completed = !("stopReason" in msg) || (msg as { stopReason: string }).stopReason !== "aborted";
			events.push({ type: "assistant_message_end", completed, timestamp: now });
			break;
		}

		// ── ★ Core: fine-grained assistantMessageEvent deltas ★ ──
		case "message_update": {
			const sub = (event as unknown as { assistantMessageEvent?: LookMessageSubEvent }).assistantMessageEvent;
			if (!sub) break;

			switch (sub.type) {
				case "text_start":
					tracker.activeTextIndices.add(sub.contentIndex);
					events.push({ type: "assistant_text_start", contentIndex: sub.contentIndex, timestamp: now });
					break;
				case "text_delta":
					events.push({
						type: "assistant_text_delta",
						contentIndex: sub.contentIndex,
						delta: sub.delta,
						timestamp: now,
					});
					break;
				case "text_end":
					tracker.activeTextIndices.delete(sub.contentIndex);
					events.push({
						type: "assistant_text_end",
						contentIndex: sub.contentIndex,
						text: sub.content,
						timestamp: now,
					});
					break;

				case "thinking_start":
					tracker.activeThinkingIndices.add(sub.contentIndex);
					events.push({ type: "thinking_start", contentIndex: sub.contentIndex, timestamp: now });
					break;
				case "thinking_delta":
					events.push({
						type: "thinking_delta",
						contentIndex: sub.contentIndex,
						delta: sub.delta,
						timestamp: now,
					});
					break;
				case "thinking_end":
					tracker.activeThinkingIndices.delete(sub.contentIndex);
					events.push({
						type: "thinking_end",
						contentIndex: sub.contentIndex,
						thinking: sub.content,
						timestamp: now,
					});
					break;

				case "toolcall_start": {
					const tcBlock = sub.partial?.content?.[sub.contentIndex];
					if (!tcBlock?.id) break; // insufficient data — toolcall_end will carry the full metadata
					tracker.activeToolCallIndices.add(sub.contentIndex);
					events.push({
						type: "toolcall_start",
						contentIndex: sub.contentIndex,
						toolCallId: tcBlock.id,
						toolName: tcBlock.name ?? "unknown",
						timestamp: now,
					});
					break;
				}
				case "toolcall_delta":
					events.push({
						type: "toolcall_arg_delta",
						contentIndex: sub.contentIndex,
						delta: sub.delta,
						timestamp: now,
					});
					break;
				case "toolcall_end":
					tracker.activeToolCallIndices.delete(sub.contentIndex);
					events.push({
						type: "toolcall_end",
						contentIndex: sub.contentIndex,
						toolCallId: sub.toolCall.id,
						toolName: sub.toolCall.name,
						args: sub.toolCall.arguments as Record<string, unknown>,
						timestamp: now,
					});
					break;

				case "done":
					finishActiveBlocks(tracker, events, now);
					break;

				case "error":
					finishActiveBlocks(tracker, events, now);
					events.push({ type: "error", message: sub.error.errorMessage ?? "Assistant error", timestamp: now });
					break;
			}
			break;
		}

		// ── Tool execution (independent of message stream) ──
		case "tool_execution_start":
			events.push({
				type: "tool_exec_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args as Record<string, unknown>,
				timestamp: now,
			});
			break;

		case "tool_execution_update":
			events.push({
				type: "tool_exec_update",
				toolCallId: event.toolCallId,
				partialResult: event.partialResult,
				timestamp: now,
			});
			break;

		case "tool_execution_end":
			events.push({
				type: "tool_exec_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
				timestamp: now,
			});
			break;

		// ── Compaction ──
		case "compaction_start":
			events.push({ type: "compacting", active: true, timestamp: now });
			break;
		case "compaction_end":
			events.push({ type: "compacting", active: false, timestamp: now });
			break;

		// ── Queue ──
		case "queue_update":
			events.push({
				type: "queue_update",
				steering: [...event.steering],
				followUp: [...event.followUp],
				timestamp: now,
			});
			break;

		// ── Auto-retry ──
		case "auto_retry_start":
			events.push({
				type: "retry_status",
				status: "start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
				timestamp: now,
			});
			break;
		case "auto_retry_end":
			events.push({
				type: "retry_status",
				status: "end",
				attempt: event.attempt,
				success: event.success,
				finalError: event.finalError,
				timestamp: now,
			});
			break;

		// ── Session metadata ──
		case "thinking_level_changed":
			events.push({ type: "session_meta", field: "thinkingLevel", value: event.level, timestamp: now });
			break;
		case "session_info_changed":
			if (event.name) {
				events.push({ type: "session_meta", field: "name", value: event.name, timestamp: now });
			}
			break;
	}

	return events;
}
