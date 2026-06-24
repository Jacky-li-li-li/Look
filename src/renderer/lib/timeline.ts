import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@shared/types";
import type { RendererLiveMessage } from "../store/sessionTypes";

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

export function buildTimeline(entries: SessionEntry[], liveMessages: RendererLiveMessage[]): TimelineItem[] {
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
					flushToolResults();
				} else {
					closeAssistantContext();
					const item: TimelineItem = {
						id: entry.id,
						entryId: entry.id,
						message: msg,
						isLive: false,
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

	closeAssistantContext();

	const liveItems: TimelineItem[] = [];
	let liveAssistant: TimelineItem | null = null;

	for (const live of liveMessages) {
		const msg = live.message;
		if (msg.role === "user") {
			liveAssistant = null;
			liveItems.push({ id: live.renderId, message: msg, isLive: true });
		} else if (isAssistantMessage(msg)) {
			if (liveAssistant?.message && isAssistantMessage(liveAssistant.message)) {
				// Same live assistant output chain: keep one avatar, append blocks.
				liveAssistant.message = mergeAssistantContent(liveAssistant.message, msg);
			} else {
				const ti: TimelineItem = { id: live.renderId, message: msg, isLive: true };
				liveItems.push(ti);
				liveAssistant = ti;
			}
		} else {
			liveItems.push({ id: live.renderId, message: msg, isLive: true });
		}
	}

	return [...items, ...liveItems];
}
