// @vitest-environment jsdom
//
// Unit tests for ChatMessageList timeline building:
// - toolResult messages attach to the preceding assistant bubble
// - consecutive assistant messages in the same output chain merge into one bubble (one avatar)
// - within the merged bubble, content blocks keep their own types (text/thinking/toolCall cards)
// - look-specific system entries are hidden from the timeline
// - discrete-event streaming blocks are appended as a single live item

import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { LookUiStreamBlock, LookUiToolExecState, SessionEntry } from "@shared/types";
import { describe, expect, it } from "vitest";
import { buildTimeline } from "../src/renderer/lib/timeline";

const baseAssistant = (id: string, content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	api: "openai-responses",
	provider: "openai",
	model: "gpt-4o",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: Date.now(),
});

const baseUser = (text: string): UserMessage => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp: Date.now(),
});

const baseToolResult = (toolCallId: string, text: string, isError = false): ToolResultMessage => ({
	role: "toolResult",
	toolCallId,
	toolName: "read",
	content: [{ type: "text", text }],
	isError,
	timestamp: Date.now(),
});

function messageEntry(id: string, message: AssistantMessage | UserMessage | ToolResultMessage): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message };
}

function modelChangeEntry(id: string): SessionEntry {
	return {
		type: "model_change",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		provider: "openai",
		modelId: "gpt-4o",
	};
}

const textBlock = (index: number, text: string, completed = false): LookUiStreamBlock => ({
	contentIndex: index,
	kind: "text",
	text,
	thinking: "",
	completed,
});

const toolcallBlock = (index: number, toolCallId: string, toolName: string, completed = false): LookUiStreamBlock => ({
	contentIndex: index,
	kind: "toolcall",
	text: "",
	thinking: "",
	toolCallId,
	toolName,
	args: {},
	completed,
});

const runningTool = (toolCallId: string, toolName: string): LookUiToolExecState => ({
	toolCallId,
	toolName,
	args: {},
	phase: "running",
});

describe("buildTimeline", () => {
	it("attaches toolResult messages to the preceding assistant bubble", () => {
		const entries: SessionEntry[] = [
			messageEntry("u1", baseUser("read file")),
			messageEntry(
				"a1",
				baseAssistant("a1", [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "x" } }]),
			),
			messageEntry("tr1", baseToolResult("tc1", "file content")),
		];

		const timeline = buildTimeline(entries);

		expect(timeline).toHaveLength(2);
		expect(timeline[0]?.message?.role).toBe("user");
		expect(timeline[1]?.message?.role).toBe("assistant");
		expect(timeline[1]?.entryId).toBe("a1");
		expect(timeline[1]?.toolResultMap).toHaveProperty("tc1");
		expect(timeline[1]?.toolResultMap?.tc1.content[0].text).toBe("file content");
	});

	it("merges consecutive assistant messages into one bubble with one avatar", () => {
		const entries: SessionEntry[] = [
			messageEntry("u1", baseUser("hello")),
			messageEntry("a1", baseAssistant("a1", [{ type: "thinking", thinking: "thinking..." }])),
			messageEntry("a2", baseAssistant("a2", [{ type: "text", text: "answer" }])),
		];

		const timeline = buildTimeline(entries);

		expect(timeline).toHaveLength(2);
		const assistantItem = timeline[1];
		expect(assistantItem?.message?.role).toBe("assistant");
		expect(assistantItem?.entryId).toBe("a1");
		expect(assistantItem?.secondaryEntryIds).toEqual(["a2"]);
		const content = (assistantItem?.message as AssistantMessage).content;
		expect(content).toHaveLength(2);
		expect(content[0].type).toBe("thinking");
		expect(content[1].type).toBe("text");
	});

	it("keeps thinking/toolCall/text blocks as individual cards inside one bubble", () => {
		const entries: SessionEntry[] = [
			messageEntry("u1", baseUser("hello")),
			messageEntry("a1", baseAssistant("a1", [{ type: "thinking", thinking: "step 1" }])),
			messageEntry(
				"a2",
				baseAssistant("a2", [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "x" } }]),
			),
			messageEntry("tr1", baseToolResult("tc1", "result")),
			messageEntry("a3", baseAssistant("a3", [{ type: "text", text: "done" }])),
		];

		const timeline = buildTimeline(entries);

		expect(timeline).toHaveLength(2);
		const content = (timeline[1]?.message as AssistantMessage).content;
		expect(content.map((b) => b.type)).toEqual(["thinking", "toolCall", "text"]);
		expect(timeline[1]?.toolResultMap).toHaveProperty("tc1");
	});

	it("does not merge assistant messages separated by a user message", () => {
		const entries: SessionEntry[] = [
			messageEntry("u1", baseUser("first")),
			messageEntry("a1", baseAssistant("a1", [{ type: "text", text: "ok" }])),
			messageEntry("u2", baseUser("second")),
			messageEntry("a2", baseAssistant("a2", [{ type: "text", text: "reply" }])),
		];

		const timeline = buildTimeline(entries);

		expect(timeline).toHaveLength(4);
		expect(timeline[1]?.entryId).toBe("a1");
		expect(timeline[3]?.entryId).toBe("a2");
	});

	it("hides all look system entries from the timeline", () => {
		const entries: SessionEntry[] = [
			modelChangeEntry("mc1"),
			messageEntry("u1", baseUser("hello")),
			modelChangeEntry("mc2"),
		];

		const timeline = buildTimeline(entries);

		expect(timeline.map((item) => item.id)).toEqual(["u1"]);
	});

	it("appends a live streaming item when uiPhase is active", () => {
		const blocks: LookUiStreamBlock[] = [textBlock(0, "hello", false)];
		const timeline = buildTimeline([], {}, blocks, {}, "streaming");

		expect(timeline).toHaveLength(1);
		expect(timeline[0]?.id).toBe("streaming-live");
		expect(timeline[0]?.isLive).toBe(true);
		expect(timeline[0]?.uiBlocks).toBe(blocks);
	});

	it("does not append a live item when uiPhase is idle even if blocks remain", () => {
		const blocks: LookUiStreamBlock[] = [textBlock(0, "hello", true)];
		const timeline = buildTimeline([], {}, blocks, {}, "idle");

		expect(timeline).toHaveLength(0);
	});

	it("does not append a live item when idle and no blocks exist", () => {
		const timeline = buildTimeline([], {}, [], {}, "idle");
		expect(timeline).toHaveLength(0);
	});

	it("carries uiTools on the live streaming item", () => {
		const blocks: LookUiStreamBlock[] = [toolcallBlock(0, "tc1", "read", true)];
		const tools: Record<string, LookUiToolExecState> = { tc1: runningTool("tc1", "read") };
		const timeline = buildTimeline([], {}, blocks, tools, "streaming");

		expect(timeline[0]?.uiTools).toBe(tools);
	});

	it("places the live item after persisted entries", () => {
		const entries: SessionEntry[] = [
			messageEntry("u1", baseUser("hello")),
			messageEntry("a1", baseAssistant("a1", [{ type: "text", text: "ok" }])),
		];
		const blocks: LookUiStreamBlock[] = [textBlock(0, "streaming", false)];

		const timeline = buildTimeline(entries, {}, blocks, {}, "streaming");

		expect(timeline).toHaveLength(3);
		expect(timeline[2]?.isLive).toBe(true);
		expect(timeline[2]?.uiBlocks).toBe(blocks);
	});

	it("attaches per-message duration to assistant bubbles", () => {
		const entries: SessionEntry[] = [
			messageEntry("u1", baseUser("hello")),
			messageEntry("a1", baseAssistant("a1", [{ type: "text", text: "first" }])),
			messageEntry("u2", baseUser("follow up")),
			messageEntry("a2", baseAssistant("a2", [{ type: "text", text: "second" }])),
		];

		const timeline = buildTimeline(entries, { a1: 1200, a2: 3400 });

		expect(timeline).toHaveLength(4);
		expect(timeline[1]?.turnDurationMs).toBe(1200);
		expect(timeline[3]?.turnDurationMs).toBe(3400);
	});

	it("picks up duration from a merged assistant entry", () => {
		const entries: SessionEntry[] = [
			messageEntry("u1", baseUser("hello")),
			messageEntry("a1", baseAssistant("a1", [{ type: "thinking", thinking: "..." }])),
			messageEntry("a2", baseAssistant("a2", [{ type: "text", text: "answer" }])),
		];

		const timeline = buildTimeline(entries, { a2: 5100 });

		expect(timeline).toHaveLength(2);
		expect(timeline[1]?.entryId).toBe("a1");
		expect(timeline[1]?.turnDurationMs).toBe(5100);
	});

	// ---- pendingUserMessage (streaming user message) ----

	it("shows pending user message during streaming when no entries exist", () => {
		const timeline = buildTimeline([], {}, [], {}, "streaming", { text: "hello world" });

		expect(timeline).toHaveLength(2);
		expect(timeline[0]?.id).toBe("pending-user");
		expect(timeline[0]?.isLive).toBe(false);
		expect(timeline[0]?.message?.role).toBe("user");
		expect((timeline[0]?.message as any)?.content[0]?.text).toBe("hello world");
		expect(timeline[1]?.id).toBe("streaming-live");
		expect(timeline[1]?.isLive).toBe(true);
	});

	it("shows pending user message before the streaming live item", () => {
		const blocks: LookUiStreamBlock[] = [textBlock(0, "streaming...", false)];
		const timeline = buildTimeline([], {}, blocks, {}, "streaming", { text: "my question" });

		expect(timeline).toHaveLength(2);
		expect(timeline[0]?.id).toBe("pending-user");
		expect(timeline[0]?.message?.role).toBe("user");
		expect(timeline[1]?.id).toBe("streaming-live");
		expect(timeline[1]?.isLive).toBe(true);
	});

	it("shows pending user message even when uiPhase is idle (holds until snapshot)", () => {
		const timeline = buildTimeline([], {}, [], {}, "idle", { text: "hello" });

		// Pending user message now persists through uiPhase transitions
		// so it won't disappear between run_status("idle") and the snapshot.
		expect(timeline).toHaveLength(1);
		expect(timeline[0]?.id).toBe("pending-user");
	});

	it("does not show pending user message when it is null even during streaming", () => {
		const blocks: LookUiStreamBlock[] = [textBlock(0, "hi", false)];
		const timeline = buildTimeline([], {}, blocks, {}, "streaming", null);

		expect(timeline).toHaveLength(1);
		expect(timeline[0]?.id).toBe("streaming-live");
	});

	it("places pending user message after persisted entries but before live item", () => {
		const entries: SessionEntry[] = [
			messageEntry("u1", baseUser("previous")),
			messageEntry("a1", baseAssistant("a1", [{ type: "text", text: "ok" }])),
		];
		const blocks: LookUiStreamBlock[] = [textBlock(0, "streaming...", false)];

		const timeline = buildTimeline(entries, {}, blocks, {}, "streaming", { text: "new question" });

		expect(timeline).toHaveLength(4); // prev user + prev assistant + pending user + live
		expect(timeline[0]?.id).toBe("u1"); // persisted user
		expect(timeline[1]?.id).toBe("a1"); // persisted assistant
		expect(timeline[2]?.id).toBe("pending-user"); // pending user
		expect(timeline[3]?.id).toBe("streaming-live"); // live streaming
	});
});
