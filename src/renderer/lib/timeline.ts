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

	// Live messages extend the same timeline. They may continue the current assistant
	// context (e.g. a toolResult streaming in for the last persisted assistant), so we
	// keep `currentAssistant` open. We also track `liveAssistant` separately so that
	// consecutive live assistant messages merge without accidentally merging a live
	// update into a persisted assistant bubble.
	const liveItems: TimelineItem[] = [];
	let liveAssistant: TimelineItem | null = null;

	for (const live of liveMessages) {
		const msg = live.message;
		if (isToolResultMessage(msg)) {
			pendingToolResults.push(msg);
			continue;
		}

		if (msg.role === "user") {
			// A user message splits the assistant chain for merging, but keep the
			// previous assistant as the toolResult context until a new assistant begins.
			flushToolResults();
			liveAssistant = null;
			liveItems.push({ id: live.renderId, message: msg, isLive: true });
		} else if (isAssistantMessage(msg)) {
			if (liveAssistant?.message && isAssistantMessage(liveAssistant.message) && liveAssistant.isLive) {
				// Same live assistant output chain: keep one avatar, append blocks.
				liveAssistant.message = mergeAssistantContent(liveAssistant.message, msg);
				flushToolResults();
			} else {
				// Flush any pending tool results that belong to the previous assistant
				// (persisted or live) before starting a new live bubble.
				flushToolResults();
				const ti: TimelineItem = { id: live.renderId, message: msg, isLive: true };
				liveAssistant = ti;
				currentAssistant = ti;
				flushToolResults();
				liveItems.push(ti);
			}
		} else {
			flushToolResults();
			liveAssistant = null;
			currentAssistant = null;
			liveItems.push({ id: live.renderId, message: msg, isLive: true });
		}
	}

	// Attach any trailing tool results to the final assistant. If no assistant exists,
	// render them as standalone items so the content is not silently dropped.
	flushToolResults();
	for (const tr of pendingToolResults) {
		liveItems.push({ id: `orphan-tr-${tr.toolCallId}`, message: tr, isLive: true });
	}

	return [...items, ...liveItems];
}
