// ============================================================
// timeline.ts — collectTurnEntryIds / collectTurnEntries（轮次变更卡片插入点）
// ============================================================

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { LookSessionEntry } from "@shared/types";
import { describe, expect, it } from "vitest";
import { collectTurnEntries, collectTurnEntryIds, type TimelineItem } from "../src/renderer/lib/timeline";

function userItem(id: string): TimelineItem {
	return { id, entryId: id, message: { role: "user", content: [] } as AgentMessage, isLive: false };
}

function assistantItem(id: string, secondary: string[] = []): TimelineItem {
	return {
		id,
		entryId: id,
		secondaryEntryIds: secondary,
		message: { role: "assistant", content: [] } as AgentMessage,
		isLive: false,
	};
}

function messageEntry(id: string, role: "user" | "assistant"): LookSessionEntry {
	return {
		type: "message",
		id,
		message: { role, content: [] } as AgentMessage,
	};
}

function toolResultEntry(id: string, toolCallId: string, isError = false): LookSessionEntry {
	return {
		type: "message",
		id,
		message: { role: "toolResult", toolCallId, isError, content: [] } as never,
	} as LookSessionEntry;
}

describe("collectTurnEntryIds", () => {
	const timeline = [
		userItem("u1"),
		assistantItem("a1", ["a1-2", "a1-3"]),
		userItem("u2"),
		assistantItem("a2"),
		userItem("u3"),
		assistantItem("a3"),
	];

	it("收集当前轮（最近的 user 消息之后）的全部 entry id，含合并的 secondaryEntryIds", () => {
		expect(collectTurnEntryIds(timeline, 1)).toEqual(["a1", "a1-2", "a1-3"]);
		expect(collectTurnEntryIds(timeline, 3)).toEqual(["a2"]);
		expect(collectTurnEntryIds(timeline, 5)).toEqual(["a3"]);
	});

	it("第一轮（无前置 user）从列表头开始收集", () => {
		expect(collectTurnEntryIds([assistantItem("a0"), userItem("u9"), assistantItem("a9")], 0)).toEqual(["a0"]);
	});

	it("user 消息自身不属于任何轮的收集范围", () => {
		expect(collectTurnEntryIds(timeline, 2)).toEqual([]);
	});

	it("原始 entries 收集同一轮隐藏的 toolResult，直到下一条 user", () => {
		const entries = [
			messageEntry("u1", "user"),
			messageEntry("a1", "assistant"),
			toolResultEntry("tr1", "tool-1"),
			messageEntry("a1-2", "assistant"),
			toolResultEntry("tr2", "tool-2", true),
			messageEntry("u2", "user"),
		];
		const turnTimeline = [userItem("u1"), assistantItem("a1", ["a1-2"]), userItem("u2")];

		expect(collectTurnEntries(entries, turnTimeline, 1).map((entry) => entry.id)).toEqual([
			"a1",
			"tr1",
			"a1-2",
			"tr2",
		]);
	});
});
