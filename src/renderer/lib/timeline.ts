import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { LookUiPhase, LookUiStreamBlock, LookUiToolExecState, SessionEntry } from "@shared/types";

export interface TimelineItem {
	id: string;
	entryId?: string;
	/** Other assistant entry IDs merged into this bubble, for diagnostics / future navigation. */
	secondaryEntryIds?: string[];
	message?: AgentMessage;
	entry?: Exclude<SessionEntry, { type: "message" }>;
	isLive: boolean;
	/** toolResult messages keyed by toolCallId, attached to the preceding assistant. */
	toolResultMap?: Record<string, ToolResultMessage>;
	/** Finalized turn duration for this persisted assistant bubble, in milliseconds. */
	turnDurationMs?: number;
	/** Discrete-event streaming blocks for the active assistant message. */
	uiBlocks?: LookUiStreamBlock[];
	/** Discrete-event tool execution states for the active assistant message. */
	uiTools?: Record<string, LookUiToolExecState>;
}

function isToolResultMessage(msg: AgentMessage): msg is ToolResultMessage {
	return msg.role === "toolResult";
}

function isAssistantMessage(msg: AgentMessage): msg is AssistantMessage {
	return msg.role === "assistant";
}

function mergeAssistantContent(target: AssistantMessage, source: AssistantMessage): AssistantMessage {
	return {
		...target,
		content: [...target.content, ...source.content],
	};
}

export function buildTimeline(
	entries: SessionEntry[],
	messageDurations: Record<string, number> = {},
	uiBlocks: LookUiStreamBlock[] = [],
	uiTools: Record<string, LookUiToolExecState> = {},
	uiPhase: LookUiPhase = "idle",
	pendingUserMessage: { text: string; images?: ImageContent[] } | null = null,
): TimelineItem[] {
	const items: TimelineItem[] = [];
	let pendingToolResults: ToolResultMessage[] = [];
	let currentAssistant: TimelineItem | null = null;

	const flushToolResults = (): void => {
		if (pendingToolResults.length === 0 || !currentAssistant) return;
		const map = Object.fromEntries(pendingToolResults.map((tr) => [tr.toolCallId, tr]));
		currentAssistant.toolResultMap = { ...(currentAssistant.toolResultMap ?? {}), ...map };
		pendingToolResults = [];
	};

	const closeAssistantContext = (): void => {
		flushToolResults();
		currentAssistant = null;
	};

	for (const entry of entries) {
		if (entry.type === "message") {
			const msg = entry.message;
			if (isToolResultMessage(msg)) {
				pendingToolResults.push(msg);
				continue;
			}

			if (isAssistantMessage(msg)) {
				if (currentAssistant?.message && isAssistantMessage(currentAssistant.message)) {
					// Same assistant output chain: merge content so thinking/toolCall/text
					// blocks all live under one bubble (one avatar) as individual cards.
					currentAssistant.message = mergeAssistantContent(currentAssistant.message, msg);
					currentAssistant.secondaryEntryIds ??= [];
					currentAssistant.secondaryEntryIds.push(entry.id);
					// If the merged entry carries the finalized duration, attach it to the bubble.
					if (messageDurations[entry.id] != null) {
						currentAssistant.turnDurationMs = messageDurations[entry.id];
					}
					flushToolResults();
				} else {
					closeAssistantContext();
					const item: TimelineItem = {
						id: entry.id,
						entryId: entry.id,
						message: msg,
						isLive: false,
						turnDurationMs: messageDurations[entry.id],
					};
					flushToolResults();
					currentAssistant = item;
					items.push(item);
				}
				continue;
			}

			// user, custom, bashExecution, branchSummary, compactionSummary, etc.
			closeAssistantContext();
			items.push({ id: entry.id, entryId: entry.id, message: msg, isLive: false });
			continue;
		}

		if (entry.type === "custom_message") {
			if (!entry.display) continue;
			closeAssistantContext();
			items.push({ id: entry.id, entryId: entry.id, entry, isLive: false });
			continue;
		}

		// Look-specific system entries are not shown in the chat timeline.
		const isLookSystemEntry =
			entry.type === "model_change" ||
			entry.type === "thinking_level_change" ||
			entry.type === "session_info" ||
			entry.type === "label" ||
			(entry.type === "custom" && entry.customType?.startsWith("look."));

		if (isLookSystemEntry) continue;

		items.push({ id: entry.id, entryId: entry.id, entry, isLive: false });
	}

	// Attach any trailing tool results to the final persisted assistant. If no
	// assistant exists, they will be orphaned; this preserves existing behavior
	// for normal streams (toolResult always follows assistant immediately) but
	// may lose results after tree navigation reorders entries.
	if (pendingToolResults.length > 0 && !currentAssistant) {
		console.warn(
			"[Look][Timeline] Orphaned tool results (no preceding assistant):",
			pendingToolResults.map((tr) => tr.toolCallId),
		);
	}
	flushToolResults();

	// Show the pending user message so the user sees their own message
	// immediately, before the snapshot with persisted entries arrives.
	// Kept visible even when uiPhase transitions to "idle" before the
	// snapshot arrives — the snapshot atomically clears pendingUserMessage
	// and updates entries, so there is no visual duplicate.
	if (pendingUserMessage) {
		const textBlock: TextContent[] = pendingUserMessage.text ? [{ type: "text", text: pendingUserMessage.text }] : [];
		const imageBlocks: ImageContent[] = pendingUserMessage.images ?? [];
		items.push({
			id: "pending-user",
			isLive: false,
			message: {
				role: "user",
				content: [...textBlock, ...imageBlocks],
			} as AgentMessage,
		});
	}

	// Append the active assistant as a single live item. Completed blocks remain
	// visible during the short idle → agent_end snapshot handoff; the snapshot
	// clears them atomically when persisted entries become the source of truth.
	if (uiPhase !== "idle" || uiBlocks.length > 0) {
		items.push({
			id: "streaming-live",
			isLive: true,
			uiBlocks,
			uiTools,
		});
	}

	return items;
}
