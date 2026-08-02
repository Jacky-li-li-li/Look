// ============================================================
// EventTranslator 行为测试
//
// 覆盖 SDK 事件 → LookUiEvent 的核心翻译路径：
//   - run lifecycle（agent_start / agent_end 合成 end 事件）
//   - 用户消息文本/图片提取
//   - assistantMessageEvent 细粒度 delta（text/thinking/toolcall）
//   - done 子事件强制收尾未关闭块
//   - 工具执行独立事件与 safeClone 兜底
//   - compaction / queue / auto_retry / session_meta
// ============================================================

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	createContentBlockTracker,
	extractUserMessageImages,
	extractUserMessageText,
	finishActiveBlocks,
	translateAgentSessionEvent,
} from "../src/main/session/events/event-translator.js";

function textUserMessage(text: string): AgentMessage {
	return { role: "user", stopReason: null, content: text } as unknown as AgentMessage;
}

function blockUserMessage(text: string, images = 0): AgentMessage {
	const content: unknown[] = [{ type: "text", text }];
	for (let i = 0; i < images; i++) {
		content.push({ type: "image", image: { data: "aGVsbG8=", mimeType: "image/png" } });
	}
	return { role: "user", stopReason: null, content } as unknown as AgentMessage;
}

function eventOf(type: string, extra: Record<string, unknown> = {}): AgentSessionEvent {
	return { type, ...extra } as unknown as AgentSessionEvent;
}

describe("extractUserMessageText", () => {
	it("returns string content for plain-text user messages", () => {
		expect(extractUserMessageText(textUserMessage("hello"))).toBe("hello");
	});

	it("joins text blocks with newlines for block content", () => {
		expect(extractUserMessageText(blockUserMessage("a\nb"))).toBe("a\nb");
	});

	it("returns empty string for non-user messages", () => {
		expect(
			extractUserMessageText({ role: "assistant", stopReason: "stop", content: "x" } as unknown as AgentMessage),
		).toBe("");
	});
});

describe("extractUserMessageImages", () => {
	it("returns undefined when no images", () => {
		expect(extractUserMessageImages(textUserMessage("hi"))).toBeUndefined();
	});

	it("returns image blocks when present", () => {
		const images = extractUserMessageImages(blockUserMessage("hi", 2));
		expect(images).toHaveLength(2);
		expect(images?.[0].type).toBe("image");
	});

	it("returns undefined for non-user messages", () => {
		expect(extractUserMessageImages({ role: "assistant", content: [] } as unknown as AgentMessage)).toBeUndefined();
	});
});

describe("finishActiveBlocks", () => {
	it("emits synthetic end events for text and thinking blocks, then clears", () => {
		const tracker = createContentBlockTracker();
		tracker.activeTextIndices.add(0);
		tracker.activeThinkingIndices.add(1);
		const events: unknown[] = [];
		finishActiveBlocks(tracker, events as never, 1234);
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({ type: "assistant_text_end", contentIndex: 0, text: "" });
		expect(events[1]).toMatchObject({ type: "thinking_end", contentIndex: 1, thinking: "" });
		expect(tracker.activeTextIndices.size).toBe(0);
		expect(tracker.activeThinkingIndices.size).toBe(0);
		expect(tracker.activeToolCallIndices.size).toBe(0);
	});

	it("does not synthesize toolcall end (SDK owns that event)", () => {
		const tracker = createContentBlockTracker();
		tracker.activeToolCallIndices.add(2);
		const events: unknown[] = [];
		finishActiveBlocks(tracker, events as never, 0);
		expect(events).toHaveLength(0);
		expect(tracker.activeToolCallIndices.size).toBe(0);
	});
});

describe("translateAgentSessionEvent — lifecycle", () => {
	it("agent_start clears trackers and emits streaming run_status", () => {
		const tracker = createContentBlockTracker();
		tracker.activeTextIndices.add(3); // stale from previous turn
		const events = translateAgentSessionEvent(eventOf("agent_start"), tracker);
		expect(events[0]).toMatchObject({ type: "run_status", status: "streaming" });
		expect(tracker.activeTextIndices.size).toBe(0);
	});

	it("agent_end synthesizes ends and emits idle run_status", () => {
		const tracker = createContentBlockTracker();
		tracker.activeTextIndices.add(0);
		const events = translateAgentSessionEvent(eventOf("agent_end", { willRetry: false }), tracker);
		expect(events.map((e) => e.type)).toContain("assistant_text_end");
		const run = events.find((e) => e.type === "run_status");
		expect(run).toMatchObject({ status: "idle", willRetry: false });
	});

	it("agent_end with willRetry emits retrying status", () => {
		const events = translateAgentSessionEvent(eventOf("agent_end", { willRetry: true }), createContentBlockTracker());
		expect(events.find((e) => e.type === "run_status")).toMatchObject({ status: "retrying", willRetry: true });
	});

	it("message_start with user message emits user_message", () => {
		const events = translateAgentSessionEvent(
			eventOf("message_start", { message: textUserMessage("ping") }),
			createContentBlockTracker(),
		);
		expect(events[0]).toMatchObject({ type: "user_message", text: "ping" });
	});

	it("message_end with assistant message emits completed end", () => {
		const events = translateAgentSessionEvent(
			eventOf("message_end", {
				message: { role: "assistant", stopReason: "stop", content: [] } as unknown as AgentMessage,
			}),
			createContentBlockTracker(),
		);
		expect(events[0]).toMatchObject({ type: "assistant_message_end", completed: true });
	});

	it("message_end with aborted assistant message emits uncompleted end", () => {
		const events = translateAgentSessionEvent(
			eventOf("message_end", {
				message: { role: "assistant", stopReason: "aborted", content: [] } as unknown as AgentMessage,
			}),
			createContentBlockTracker(),
		);
		expect(events[0]).toMatchObject({ type: "assistant_message_end", completed: false });
	});
});

describe("translateAgentSessionEvent — assistant deltas", () => {
	it("text_start / text_delta / text_end maintain contentIndex and tracker", () => {
		const tracker = createContentBlockTracker();
		const start = translateAgentSessionEvent(
			eventOf("message_update", { assistantMessageEvent: { type: "text_start", contentIndex: 0 } }),
			tracker,
		);
		expect(start[0]).toMatchObject({ type: "assistant_text_start", contentIndex: 0 });
		expect(tracker.activeTextIndices.has(0)).toBe(true);

		const delta = translateAgentSessionEvent(
			eventOf("message_update", {
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
			}),
			tracker,
		);
		expect(delta[0]).toMatchObject({ type: "assistant_text_delta", contentIndex: 0, delta: "Hel" });

		const end = translateAgentSessionEvent(
			eventOf("message_update", {
				assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello" },
			}),
			tracker,
		);
		expect(end[0]).toMatchObject({ type: "assistant_text_end", contentIndex: 0, text: "Hello" });
		expect(tracker.activeTextIndices.has(0)).toBe(false);
	});

	it("toolcall_start reads name/id from partial content block", () => {
		const tracker = createContentBlockTracker();
		const events = translateAgentSessionEvent(
			eventOf("message_update", {
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 1,
					partial: {
						content: [
							{ type: "text", text: "ignored" },
							{ type: "toolCall", id: "call-1", name: "bash" },
						],
					},
				},
			}),
			tracker,
		);
		expect(events[0]).toMatchObject({
			type: "toolcall_start",
			contentIndex: 1,
			toolCallId: "call-1",
			toolName: "bash",
		});
		expect(tracker.activeToolCallIndices.has(1)).toBe(true);
	});

	it("AssistantMessageEvent start clears trackers and emits no UI events (delta-rebuild)", () => {
		// start 携带完整 partial 快照，但内容由后续增量事件重建——显式忽略，
		// 仅清空 tracker 确保新 turn 无残留。
		const tracker = createContentBlockTracker();
		tracker.activeTextIndices.add(0);
		tracker.activeThinkingIndices.add(1);
		tracker.activeToolCallIndices.add(2);
		const events = translateAgentSessionEvent(
			eventOf("message_update", {
				assistantMessageEvent: {
					type: "start",
					partial: { role: "assistant", content: [{ type: "text", text: "hello" }] },
				},
			}),
			tracker,
		);
		expect(events).toHaveLength(0);
		expect(tracker.activeTextIndices.size).toBe(0);
		expect(tracker.activeThinkingIndices.size).toBe(0);
		expect(tracker.activeToolCallIndices.size).toBe(0);
	});

	it("message_start with toolResult role emits no UI events", () => {
		// toolResult 内容由 toolcall_end 携带，message_start 无需渲染。
		const tracker = createContentBlockTracker();
		const events = translateAgentSessionEvent(
			eventOf("message_start", {
				message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "out" }] },
			}),
			tracker,
		);
		expect(events).toHaveLength(0);
	});

	it("toolcall_end emits args and clears tracker", () => {
		const tracker = createContentBlockTracker();
		tracker.activeToolCallIndices.add(1);
		const events = translateAgentSessionEvent(
			eventOf("message_update", {
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 1,
					toolCall: { id: "call-1", name: "bash", arguments: { command: "ls" } },
				},
			}),
			tracker,
		);
		expect(events[0]).toMatchObject({
			type: "toolcall_end",
			contentIndex: 1,
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "ls" },
		});
		expect(tracker.activeToolCallIndices.has(1)).toBe(false);
	});

	it("done sub-event forces finishActiveBlocks", () => {
		const tracker = createContentBlockTracker();
		tracker.activeTextIndices.add(0);
		const events = translateAgentSessionEvent(
			eventOf("message_update", { assistantMessageEvent: { type: "done" } }),
			tracker,
		);
		expect(events.map((e) => e.type)).toContain("assistant_text_end");
		expect(tracker.activeTextIndices.size).toBe(0);
	});

	it("error sub-event emits error and finishes blocks", () => {
		const tracker = createContentBlockTracker();
		tracker.activeThinkingIndices.add(2);
		const events = translateAgentSessionEvent(
			eventOf("message_update", {
				assistantMessageEvent: { type: "error", error: { errorMessage: "boom" } },
			}),
			tracker,
		);
		expect(events.map((e) => e.type)).toContain("thinking_end");
		expect(events.find((e) => e.type === "error")).toMatchObject({ message: "boom" });
	});

	it("message_update without assistantMessageEvent is a no-op", () => {
		const events = translateAgentSessionEvent(eventOf("message_update"), createContentBlockTracker());
		expect(events).toHaveLength(0);
	});
});

describe("translateAgentSessionEvent — tools / compaction / queue / retry / meta", () => {
	it("tool_execution_start forwards args via safeClone", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const events = translateAgentSessionEvent(
			eventOf("tool_execution_start", { toolCallId: "t1", toolName: "grep", args: { pattern: "x" } }),
			createContentBlockTracker(),
		);
		expect(events[0]).toMatchObject({
			type: "tool_exec_start",
			toolCallId: "t1",
			toolName: "grep",
			args: { pattern: "x" },
		});
		vi.restoreAllMocks();
	});

	it("tool_execution_end forwards result and isError", () => {
		const events = translateAgentSessionEvent(
			eventOf("tool_execution_end", { toolCallId: "t1", toolName: "grep", result: { ok: true }, isError: false }),
			createContentBlockTracker(),
		);
		expect(events[0]).toMatchObject({
			type: "tool_exec_end",
			toolCallId: "t1",
			isError: false,
			result: { ok: true },
		});
	});

	it("compaction start/end toggle active flag", () => {
		const t = createContentBlockTracker();
		expect(translateAgentSessionEvent(eventOf("compaction_start"), t)[0]).toMatchObject({
			type: "compacting",
			active: true,
		});
		expect(translateAgentSessionEvent(eventOf("compaction_end"), t)[0]).toMatchObject({
			type: "compacting",
			active: false,
		});
	});

	it("queue_update copies steering and followUp arrays", () => {
		const events = translateAgentSessionEvent(
			eventOf("queue_update", { steering: ["a"], followUp: ["b"] }),
			createContentBlockTracker(),
		);
		expect(events[0]).toMatchObject({ type: "queue_update", steering: ["a"], followUp: ["b"] });
	});

	it("auto_retry_start emits retry_status start", () => {
		const events = translateAgentSessionEvent(
			eventOf("auto_retry_start", { attempt: 1, maxAttempts: 3, delayMs: 500, errorMessage: "e" }),
			createContentBlockTracker(),
		);
		expect(events[0]).toMatchObject({ type: "retry_status", status: "start", attempt: 1, maxAttempts: 3 });
	});

	it("auto_retry_end emits retry_status end with success", () => {
		const events = translateAgentSessionEvent(
			eventOf("auto_retry_end", { attempt: 2, success: true, finalError: null }),
			createContentBlockTracker(),
		);
		expect(events[0]).toMatchObject({ type: "retry_status", status: "end", success: true });
	});

	it("thinking_level_changed / session_info_changed emit session_meta", () => {
		const t = createContentBlockTracker();
		expect(translateAgentSessionEvent(eventOf("thinking_level_changed", { level: "high" }), t)[0]).toMatchObject({
			type: "session_meta",
			field: "thinkingLevel",
			value: "high",
		});
		const events = translateAgentSessionEvent(eventOf("session_info_changed", { name: "New chat" }), t);
		expect(events[0]).toMatchObject({ type: "session_meta", field: "name", value: "New chat" });
	});

	it("session_info_changed without name emits nothing", () => {
		const events = translateAgentSessionEvent(
			eventOf("session_info_changed", { name: null }),
			createContentBlockTracker(),
		);
		expect(events).toHaveLength(0);
	});
});
