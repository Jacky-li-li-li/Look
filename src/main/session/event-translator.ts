import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent, ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { LookUiEvent } from "@look/shared/types";

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
	if (message.role !== "user") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

/** Extract image content blocks from a user AgentMessage. */
export function extractUserMessageImages(message: AgentMessage): ImageContent[] | undefined {
	if (message.role !== "user") return undefined;
	const content = message.content;
	if (typeof content === "string") return undefined;
	const images = content.filter((b): b is ImageContent => b.type === "image");
	return images.length > 0 ? images : undefined;
}

/**
 * Guard against non-serializable values reaching the structured-clone IPC boundary.
 * Returns the original value if it round-trips through structuredClone, or a safe
 * fallback string when serialization fails (e.g. functions, Symbols, DOM nodes). */
function safeClone<T>(value: T, context?: string): T {
	try {
		structuredClone(value);
		return value;
	} catch (err) {
		console.warn(
			`[Look][EventTranslator] Value failed structuredClone${context ? ` [${context}]` : ""} — replacing with placeholder.`,
			err instanceof Error ? err.message : String(err),
		);
		return "[non-serializable value]" as unknown as T;
	}
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
			const msg = event.message;
			if (msg.role === "user") {
				const text = extractUserMessageText(msg);
				const images = extractUserMessageImages(msg);
				events.push({ type: "user_message", text, images, timestamp: now });
			} else if (msg.role === "assistant") {
				events.push({ type: "assistant_message_start", timestamp: now });
			}
			break;
		}

		case "message_end": {
			finishActiveBlocks(tracker, events, now);
			const msg = event.message;
			// Only assistant messages carry stopReason; user/toolResult are always complete.
			const completed = msg.role !== "assistant" || msg.stopReason !== "aborted";
			events.push({ type: "assistant_message_end", completed, timestamp: now });
			break;
		}

		// ── ★ Core: fine-grained assistantMessageEvent deltas ★ ──
		case "message_update": {
			const sub: AssistantMessageEvent | undefined = event.assistantMessageEvent;
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
					const block = sub.partial?.content?.[sub.contentIndex];
					if (!block || block.type !== "toolCall") break;
					tracker.activeToolCallIndices.add(sub.contentIndex);
					events.push({
						type: "toolcall_start",
						contentIndex: sub.contentIndex,
						toolCallId: block.id,
						toolName: block.name,
						timestamp: now,
					});
					break;
				}
				case "toolcall_delta":
					if (sub.delta == null) break;
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
				args: safeClone(event.args, "tool_exec_start") as Record<string, unknown>,
				timestamp: now,
			});
			break;

		case "tool_execution_update":
			events.push({
				type: "tool_exec_update",
				toolCallId: event.toolCallId,
				partialResult: safeClone(event.partialResult, "tool_exec_update"),
				timestamp: now,
			});
			break;

		case "tool_execution_end":
			events.push({
				type: "tool_exec_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: safeClone(event.result, "tool_exec_end"),
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
