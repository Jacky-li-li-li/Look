// @vitest-environment jsdom
//
// Unit tests for ChatMessageList timeline building:
// - toolResult messages attach to the preceding assistant bubble
// - consecutive assistant messages in the same output chain merge into one bubble (one avatar)
// - within the merged bubble, content blocks keep their own types (text/thinking/toolCall cards)
// - look-specific system entries are hidden from the timeline

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@shared/types";
import { describe, expect, it } from "vitest";
import { buildTimeline } from "../src/renderer/lib/timeline";
import type { RendererLiveMessage } from "../src/renderer/store/sessionTypes";

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

function messageEntry(id: string, message: AgentMessage): SessionEntry {
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

describe("buildTimeline", () => {
	it("attaches toolResult messages to the preceding assistant bubble", () => {
		const entries: SessionEntry[] = [
			messageEntry("u1", baseUser("read file")),
			messageEntry("a1", baseAssistant("a1", [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "x" } }])),
			messageEntry("tr1", baseToolResult("tc1", "file content")),
		];

		const timeline = buildTimeline(entries, []);

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

		const timeline = buildTimeline(entries, []);

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
			messageEntry("a2", baseAssistant("a2", [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "x" } }])),
			messageEntry("tr1", baseToolResult("tc1", "result")),
			messageEntry("a3", baseAssistant("a3", [{ type: "text", text: "done" }])),
		];

		const timeline = buildTimeline(entries, []);

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

		const timeline = buildTimeline(entries, []);

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

		const timeline = buildTimeline(entries, []);

		expect(timeline.map((item) => item.id)).toEqual(["u1"]);
	});

	it("merges consecutive live assistant updates into one bubble", () => {
		const liveMessages: RendererLiveMessage[] = [
			{
				renderId: "live-a1",
				runId: 1,
				message: baseAssistant("live-a1", [{ type: "thinking", thinking: "thinking..." }]),
				completed: false,
			},
			{
				renderId: "live-a2",
				runId: 1,
				message: baseAssistant("live-a2", [{ type: "text", text: "answer" }]),
				completed: false,
			},
		];

		const timeline = buildTimeline([], liveMessages);

		expect(timeline).toHaveLength(1);
		const content = (timeline[0]?.message as AssistantMessage).content;
		expect(content).toHaveLength(2);
		expect(content[0].type).toBe("thinking");
		expect(content[1].type).toBe("text");
	});

	it("does not merge live assistant messages separated by a user message", () => {
		const liveMessages: RendererLiveMessage[] = [
			{
				renderId: "live-a1",
				runId: 1,
				message: baseAssistant("live-a1", [{ type: "text", text: "run 1" }]),
				completed: false,
			},
			{
				renderId: "live-u1",
				runId: 1,
				message: baseUser("steering"),
				completed: false,
			},
			{
				renderId: "live-a2",
				runId: 2,
				message: baseAssistant("live-a2", [{ type: "text", text: "run 2" }]),
				completed: false,
			},
		];

		const timeline = buildTimeline([], liveMessages);

		expect(timeline).toHaveLength(3);
		expect(timeline[0]?.id).toBe("live-a1");
		expect(timeline[1]?.id).toBe("live-u1");
		expect(timeline[2]?.id).toBe("live-a2");
	});
});
