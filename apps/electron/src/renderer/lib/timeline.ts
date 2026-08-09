import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { LookSessionEntry, LookUiPhase, LookUiStreamBlock, LookUiToolExecState } from "@shared/types";

export interface TimelineItem {
	id: string;
	entryId?: string;
	/** Other assistant entry IDs merged into this bubble, for diagnostics / future navigation. */
	secondaryEntryIds?: string[];
	message?: AgentMessage;
	entry?: Exclude<LookSessionEntry, { type: "message" }>;
	isLive: boolean;
	/** toolResult messages keyed by toolCallId, attached to the preceding assistant. */
	toolResultMap?: Record<string, ToolResultMessage>;
	/** Finalized turn duration for this persisted assistant bubble, in milliseconds. */
	turnDurationMs?: number;
	/** Discrete-event streaming blocks for the active assistant message. */
	uiBlocks?: LookUiStreamBlock[];
	/** Discrete-event tool execution states for the active assistant message. */
	uiTools?: Record<string, LookUiToolExecState>;
	/** Compaction status display. */
	compactionPhase?: "compacting" | "done";
	/** The compaction summary Markdown text (when phase is "done"). */
	compactionSummary?: string;
	/** Tokens before compaction (from CompactionEntry.tokensBefore). */
	compactionTokensBefore?: number;
	/** Estimated tokens after compaction (from CompactionResult.estimatedTokensAfter). */
	compactionEstimatedTokensAfter?: number;
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

/**
 * Build only immutable persisted rows. Live UI events should not force this
 * O(history) pass; ChatMessageList overlays them with applyLiveTimeline().
 */
export function buildPersistedTimeline(
	entries: LookSessionEntry[],
	messageDurations: Record<string, number> = {},
	compactionEstimatedTokensAfter?: number,
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
					currentAssistant.message = mergeAssistantContent(currentAssistant.message, msg);
					currentAssistant.secondaryEntryIds ??= [];
					currentAssistant.secondaryEntryIds.push(entry.id);
					if (messageDurations[entry.id] != null) currentAssistant.turnDurationMs = messageDurations[entry.id];
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
					currentAssistant = item;
					items.push(item);
				}
				continue;
			}

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

		if (entry.type === "compaction") {
			closeAssistantContext();
			items.push({
				id: entry.id,
				entryId: entry.id,
				isLive: false,
				compactionPhase: "done",
				compactionSummary: entry.summary,
				compactionTokensBefore:
					"tokensBefore" in entry ? (entry as { tokensBefore: number }).tokensBefore : undefined,
				compactionEstimatedTokensAfter,
			});
			continue;
		}

		const isLookSystemEntry =
			entry.type === "model_change" ||
			entry.type === "thinking_level_change" ||
			entry.type === "session_info" ||
			entry.type === "label" ||
			entry.type === "branch_summary" ||
			(entry.type === "custom" && entry.customType?.startsWith("look."));

		if (isLookSystemEntry) continue;
		items.push({ id: entry.id, entryId: entry.id, entry, isLive: false });
	}

	if (pendingToolResults.length > 0 && !currentAssistant) {
		console.warn(
			"[Look][Timeline] Orphaned tool results (no preceding assistant):",
			pendingToolResults.map((tr) => tr.toolCallId),
		);
	}
	flushToolResults();
	return items;
}

/** Overlay pending user/live/compaction state without rebuilding persisted rows. */
export function applyLiveTimeline(
	base: readonly TimelineItem[],
	uiBlocks: LookUiStreamBlock[] = [],
	uiTools: Record<string, LookUiToolExecState> = {},
	uiPhase: LookUiPhase = "idle",
	pendingUserMessage: { text: string; images?: ImageContent[] } | null = null,
): TimelineItem[] {
	const items = base.length > 0 ? [...base] : [];

	if (pendingUserMessage) {
		const textBlock: TextContent[] = pendingUserMessage.text ? [{ type: "text", text: pendingUserMessage.text }] : [];
		const imageBlocks: ImageContent[] = pendingUserMessage.images ?? [];
		items.push({
			id: "pending-user",
			isLive: false,
			message: { role: "user", content: [...textBlock, ...imageBlocks] } as AgentMessage,
		});
	}

	const hasCompactionEntry = items.some((item) => item.compactionPhase === "done");
	if (uiPhase === "compacting" && !hasCompactionEntry) {
		items.push({ id: "compacting-live", isLive: true, compactionPhase: "compacting" });
	} else if (uiPhase !== "idle" || uiBlocks.length > 0) {
		const canAttachToPersisted = !pendingUserMessage && items.at(-1)?.message?.role === "assistant";
		if (canAttachToPersisted) {
			const last = items.at(-1);
			if (last) {
				items[items.length - 1] = { ...last, isLive: true, uiBlocks, uiTools };
			}
		} else {
			items.push({ id: "streaming-live", isLive: true, uiBlocks, uiTools });
		}
	}

	return items;
}

/** Backward-compatible composition helper used by unit tests and callers. */
export function buildTimeline(
	entries: LookSessionEntry[],
	messageDurations: Record<string, number> = {},
	uiBlocks: LookUiStreamBlock[] = [],
	uiTools: Record<string, LookUiToolExecState> = {},
	uiPhase: LookUiPhase = "idle",
	pendingUserMessage: { text: string; images?: ImageContent[] } | null = null,
	compactionEstimatedTokensAfter?: number,
): TimelineItem[] {
	return applyLiveTimeline(
		buildPersistedTimeline(entries, messageDurations, compactionEstimatedTokensAfter),
		uiBlocks,
		uiTools,
		uiPhase,
		pendingUserMessage,
	);
}

export function collectTurnEntryIds(timeline: readonly TimelineItem[], index: number): string[] {
	// 按 item 分段收集（每段内部 entryId + secondaryEntryIds 已是正向顺序），
	// 收集方向从后往前，最后翻转段顺序恢复时间序
	const segments: string[][] = [];
	for (let i = index; i >= 0; i--) {
		const it = timeline[i];
		if (!it) break;
		if (it.message?.role === "user") break;
		if (it.entryId) segments.push([it.entryId, ...(it.secondaryEntryIds ?? [])]);
	}
	return segments.reverse().flat();
}

/**
 * 按 timeline 的轮次边界取回原始 entries。
 *
 * timeline 会把 toolResult 附着到前一个 assistant item，不会把它们作为独立
 * item 渲染；变更卡片仍需要这些原始结果来读取真实 patch 和 isError 状态。
 * 因此先用 timeline 定位 assistant 段，再在 entries 中延伸到下一条 user。
 */
export function collectTurnEntries(
	entries: readonly LookSessionEntry[],
	timeline: readonly TimelineItem[],
	index: number,
): LookSessionEntry[] {
	const turnIds = new Set(collectTurnEntryIds(timeline, index));
	if (turnIds.size === 0) return [];

	const start = entries.findIndex((entry) => turnIds.has(entry.id));
	if (start < 0) return [];

	let end = entries.length;
	for (let i = start + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (entry?.type === "message" && entry.message.role === "user") {
			end = i;
			break;
		}
	}
	return entries.slice(start, end);
}
