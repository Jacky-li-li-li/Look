// @vitest-environment jsdom
//
// MessageBlockList 双源等价性测试：
// - 快照路径（pi-ai blocks）与流式路径（LookUiStreamBlock）经 UnifiedBlock
//   归一后，渲染出相同的 ToolCallCard / 文本 / 思考块结构
// - 流式转换缓存：相同源 block 引用 → 相同 UnifiedBlock 对象（memo 前提）

import type { ToolCall } from "@earendil-works/pi-ai";
import type { LookUiStreamBlock, LookUiToolExecState } from "@shared/types";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { toUnifiedFromPiAi, toUnifiedFromStream } from "../src/renderer/components/chat/block-renderer/blockTypes";
import { MessageBlockList } from "../src/renderer/components/chat/block-renderer/MessageBlockList";
import { StreamingBlocksBubble } from "../src/renderer/components/chat/MessageBubble";

afterEach(cleanup);

const toolExecution: LookUiToolExecState = {
	toolCallId: "tc1",
	toolName: "read",
	args: { path: "/tmp/a" },
	phase: "completed",
	result: "file content",
};

function snapshotBlocks(): Array<{ type: "text" | "toolCall" } & Record<string, unknown>> {
	return [
		{ type: "text", text: "hello" },
		{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "/tmp/a" } },
	];
}

function streamBlocks(): LookUiStreamBlock[] {
	return [
		{ contentIndex: 0, kind: "text", text: "hello", thinking: "", completed: true, uid: 1 },
		{
			contentIndex: 1,
			kind: "toolcall",
			text: "",
			thinking: "",
			toolCallId: "tc1",
			toolName: "read",
			args: { path: "/tmp/a" },
			completed: true,
			uid: 2,
		},
	];
}

describe("toUnifiedFromStream cache", () => {
	it("returns the same UnifiedBlock for the same source reference", () => {
		const blocks = streamBlocks();
		const first = toUnifiedFromStream(blocks);
		const second = toUnifiedFromStream(blocks);
		expect(first[0]).toBe(second[0]);
		expect(first[1]).toBe(second[1]);
	});
});

describe("MessageBlockList dual-source equivalence", () => {
	it("renders text and tool call cards from snapshot blocks", () => {
		const blocks = snapshotBlocks() as unknown as Array<
			| import("@earendil-works/pi-ai").TextContent
			| import("@earendil-works/pi-ai").ThinkingContent
			| import("@earendil-works/pi-ai").ImageContent
			| ToolCall
		>;
		const unified = toUnifiedFromPiAi(blocks);
		const { container } = render(
			<MessageBlockList
				blocks={unified}
				isStreaming={false}
				autoCollapse={false}
				toolExecutions={{ tc1: toolExecution }}
				defaultToolStatus="pending"
			/>,
		);
		expect(container.textContent).toContain("hello");
		expect(container.textContent).toContain("read");
		expect(container.textContent).toContain("file content");
	});

	it("renders text and tool call cards from stream blocks", () => {
		const unified = toUnifiedFromStream(streamBlocks());
		const { container } = render(
			<MessageBlockList
				blocks={unified}
				isStreaming={false}
				autoCollapse={false}
				toolExecutions={{ tc1: toolExecution }}
				defaultToolStatus="running"
			/>,
		);
		expect(container.textContent).toContain("hello");
		expect(container.textContent).toContain("read");
		expect(container.textContent).toContain("file content");
	});

	it("groups consecutive thinking/toolcall blocks into a collapsible group", () => {
		const blocks = [
			{ type: "text", text: "first" },
			{ type: "thinking", thinking: "step" },
			{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "/tmp/a" } },
		] as unknown as Array<
			| import("@earendil-works/pi-ai").TextContent
			| import("@earendil-works/pi-ai").ThinkingContent
			| import("@earendil-works/pi-ai").ImageContent
			| ToolCall
		>;
		const unified = toUnifiedFromPiAi(blocks);
		const { container } = render(
			<MessageBlockList
				blocks={unified}
				isStreaming={false}
				autoCollapse={false}
				toolExecutions={{ tc1: toolExecution }}
				defaultToolStatus="pending"
			/>,
		);
		expect(container.textContent).toContain("first");
		expect(container.textContent).toContain("read");
		// thinking + toolCall 组成折叠组：组头会显示工具计数徽标
		expect(container.querySelector("[data-execution-group]")).toBeTruthy();
	});

	it("shows streaming loading indicator only while streaming with no blocks (StreamingBlocksBubble layer)", () => {
		const { container } = render(
			<StreamingBlocksBubble blocks={[]} toolExecutions={{}} isStreaming={true} autoCollapse={false} />,
		);
		expect(container.textContent).toContain("Thinking");
	});
});
