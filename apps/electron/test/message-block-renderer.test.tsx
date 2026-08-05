// @vitest-environment jsdom
//
// MessageBlockList 双源等价性测试：
// - 快照路径（pi-ai blocks）与流式路径（LookUiStreamBlock）经 UnifiedBlock
//   归一后，渲染出相同的 ToolCallCard / 文本 / 思考块结构
// - 流式转换缓存：相同源 block 引用 → 相同 UnifiedBlock 对象（memo 前提）

import type { ToolCall } from "@earendil-works/pi-ai";
import type { LookUiStreamBlock, LookUiToolExecState } from "@shared/types";
import { cleanup, render } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import { toUnifiedFromPiAi, toUnifiedFromStream } from "../src/renderer/components/chat/block-renderer/blockTypes";
import { MessageBlockList } from "../src/renderer/components/chat/block-renderer/MessageBlockList";
import { StreamingBlocksBubble } from "../src/renderer/components/chat/StreamingBlocksBubble";
import { streamingPhase } from "../src/renderer/components/chat/StreamingStatusBar";
import { showToolExecutionAtom } from "../src/renderer/store/settingsAtoms";

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

	it("thinking: stream source uses !completed (not last-block) semantics", () => {
		// 流式源：thinking 未完成即 active（即使它不是最后一块）。
		const blocks: LookUiStreamBlock[] = [
			{ contentIndex: 0, kind: "thinking", text: "", thinking: "step 1", completed: false, uid: 1 },
			{ contentIndex: 1, kind: "text", text: "after", thinking: "", completed: true, uid: 2 },
		];
		const unified = toUnifiedFromStream(blocks);
		const { container } = render(
			<MessageBlockList
				blocks={unified}
				isStreaming={true}
				autoCollapse={false}
				toolExecutions={{}}
				defaultToolStatus="running"
			/>,
		);
		// thinking 未完成 → ThinkingPanel 显示 reasoning 骨架/内容
		expect(container.textContent).toContain("step 1");
		expect(container.querySelector("[data-thinking-panel]")).toBeTruthy();
	});

	it("thinking: snapshot source activates only the last block while streaming", () => {
		// 快照源：isStreaming 时只有最后一块 thinking active；
		// 前面已完成 thinking 不应显示 skeleton（ThinkingPanel 空内容时不渲染）。
		const blocks = [
			{ type: "thinking", thinking: "step 1" },
			{ type: "text", text: "answer" },
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
				isStreaming={true}
				autoCollapse={false}
				toolExecutions={{}}
				defaultToolStatus="pending"
			/>,
		);
		expect(container.textContent).toContain("answer");
	});

	it("subagent tool calls are carved out into their own group", () => {
		// subagent 类工具（delegate_agent 等）应独立成组，不混入普通折叠组。
		const blocks = [
			{ type: "text", text: "before" },
			{ type: "toolCall", id: "sa1", name: "delegate_agent", arguments: { task: "x" } },
			{ type: "text", text: "after" },
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
				toolExecutions={{
					sa1: { toolCallId: "sa1", toolName: "delegate_agent", args: {}, phase: "completed" },
				}}
				defaultToolStatus="pending"
			/>,
		);
		expect(container.textContent).toContain("before");
		expect(container.textContent).toContain("after");
		expect(container.textContent).toContain("delegate_agent");
	});

	it("defaultToolStatus: stream subagent without execution renders without crash", () => {
		// 无 execution 的 subagent：流式路径默认 running，快照路径默认 pending。
		const subagentBlocks: LookUiStreamBlock[] = [
			{
				contentIndex: 0,
				kind: "toolcall",
				text: "",
				thinking: "",
				toolCallId: "sa1",
				toolName: "delegate_agent",
				args: {},
				completed: true,
				uid: 1,
			},
		];
		const unified = toUnifiedFromStream(subagentBlocks);
		const { container } = render(
			<MessageBlockList
				blocks={unified}
				isStreaming={false}
				autoCollapse={false}
				toolExecutions={{}}
				defaultToolStatus="running"
			/>,
		);
		expect(container.textContent).toContain("delegate_agent");
	});

	it("stream image without image data renders nothing (no broken img)", () => {
		const blocks: LookUiStreamBlock[] = [
			{ contentIndex: 0, kind: "image", text: "", thinking: "", completed: true, uid: 1 },
		];
		const unified = toUnifiedFromStream(blocks);
		const { container } = render(
			<MessageBlockList
				blocks={unified}
				isStreaming={false}
				autoCollapse={false}
				toolExecutions={{}}
				defaultToolStatus="running"
			/>,
		);
		// 不再渲染 data:image/png;base64, 坏图
		expect(container.querySelector("img")).toBeNull();
	});
});

describe("MessageBlockList showToolExecution toggle", () => {
	const mixedBlocks = () =>
		toUnifiedFromPiAi([
			{ type: "text", text: "hello" },
			{ type: "thinking", thinking: "step" },
			{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "/tmp/a" } },
			{ type: "toolCall", id: "sa1", name: "delegate_agent", arguments: { task: "x" } },
		] as unknown as Array<
			| import("@earendil-works/pi-ai").TextContent
			| import("@earendil-works/pi-ai").ThinkingContent
			| import("@earendil-works/pi-ai").ImageContent
			| ToolCall
		>);

	it("default (true) renders thinking + tool groups", () => {
		const { container } = render(
			<MessageBlockList
				blocks={mixedBlocks()}
				isStreaming={false}
				autoCollapse={false}
				toolExecutions={{
					tc1: { toolCallId: "tc1", toolName: "read", args: {}, phase: "completed", result: "file content" },
					sa1: { toolCallId: "sa1", toolName: "delegate_agent", args: {}, phase: "completed" },
				}}
				defaultToolStatus="pending"
			/>,
		);
		expect(container.textContent).toContain("hello");
		expect(container.textContent).toContain("read");
		expect(container.textContent).toContain("delegate_agent");
	});

	it("off hides thinking and tool calls, keeps text", () => {
		const store = createStore();
		store.set(showToolExecutionAtom, false);
		const { container } = render(
			<Provider store={store}>
				<MessageBlockList
					blocks={mixedBlocks()}
					isStreaming={false}
					autoCollapse={false}
					toolExecutions={{
						tc1: { toolCallId: "tc1", toolName: "read", args: {}, phase: "completed", result: "file content" },
						sa1: { toolCallId: "sa1", toolName: "delegate_agent", args: {}, phase: "completed" },
					}}
					defaultToolStatus="pending"
				/>
			</Provider>,
		);
		expect(container.textContent).toContain("hello");
		expect(container.textContent).not.toContain("read");
		expect(container.textContent).not.toContain("file content");
		expect(container.textContent).not.toContain("delegate_agent");
		expect(container.textContent).not.toContain("step");
		expect(container.querySelector("[data-execution-group]")).toBeNull();
		expect(container.querySelector("[data-thinking-panel]")).toBeNull();
	});

	it("off with only execution blocks renders nothing", () => {
		const store = createStore();
		store.set(showToolExecutionAtom, false);
		const { container } = render(
			<Provider store={store}>
				<MessageBlockList
					blocks={toUnifiedFromPiAi([
						{ type: "thinking", thinking: "step" },
						{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "/tmp/a" } },
					] as unknown as Array<
						| import("@earendil-works/pi-ai").TextContent
						| import("@earendil-works/pi-ai").ThinkingContent
						| import("@earendil-works/pi-ai").ImageContent
						| ToolCall
					>)}
					isStreaming={false}
					autoCollapse={false}
					toolExecutions={{}}
					defaultToolStatus="pending"
				/>
			</Provider>,
		);
		expect(container.innerHTML).toBe("");
	});
});

describe("StreamingStatusBar — streamingPhase 阶段判定", () => {
	it("no blocks while streaming → thinking", () => {
		expect(streamingPhase([], true)).toBe("thinking");
	});

	it("not streaming → null", () => {
		expect(streamingPhase([], false)).toBeNull();
	});

	it("incomplete toolcall → tool", () => {
		const blocks: LookUiStreamBlock[] = [
			{
				contentIndex: 0,
				kind: "toolcall",
				text: "",
				thinking: "",
				toolCallId: "t1",
				toolName: "read",
				completed: false,
				uid: 1,
			},
		];
		expect(streamingPhase(blocks, true)).toBe("tool");
	});

	it("incomplete thinking wins over completed text → thinking", () => {
		const blocks: LookUiStreamBlock[] = [
			{ contentIndex: 0, kind: "thinking", text: "", thinking: "step", completed: false, uid: 1 },
			{ contentIndex: 1, kind: "text", text: "done", thinking: "", completed: true, uid: 2 },
		];
		expect(streamingPhase(blocks, true)).toBe("thinking");
	});

	it("streaming text with content → text", () => {
		const blocks: LookUiStreamBlock[] = [
			{ contentIndex: 0, kind: "text", text: "hello", thinking: "", completed: false, uid: 1 },
		];
		expect(streamingPhase(blocks, true)).toBe("text");
	});

	it("all completed and no text → thinking fallback", () => {
		const blocks: LookUiStreamBlock[] = [
			{
				contentIndex: 0,
				kind: "toolcall",
				text: "",
				thinking: "",
				toolCallId: "t1",
				toolName: "read",
				completed: true,
				uid: 1,
			},
		];
		expect(streamingPhase(blocks, true)).toBe("thinking");
	});
});

describe("StreamingStatusBar — 九宫格状态行渲染", () => {
	it("renders thinking status bar with cube loader and elapsed", () => {
		const { container } = render(
			<StreamingBlocksBubble blocks={[]} toolExecutions={{}} isStreaming={true} autoCollapse={false} />,
		);
		// en i18n 默认 → "Thinking…"
		expect(container.textContent).toContain("Thinking…");
		// 九宫格 3×3 = 9 个方块
		expect(container.querySelectorAll(".look-cube-loader__cube")).toHaveLength(9);
		// 计时显示（0s 或 1s）
		expect(container.textContent).toMatch(/\d+s/);
	});

	it("renders tool status bar while toolcall is running", () => {
		const blocks: LookUiStreamBlock[] = [
			{
				contentIndex: 0,
				kind: "toolcall",
				text: "",
				thinking: "",
				toolCallId: "t1",
				toolName: "read",
				completed: false,
				uid: 1,
			},
		];
		const { container } = render(
			<StreamingBlocksBubble blocks={blocks} toolExecutions={{}} isStreaming={true} autoCollapse={false} />,
		);
		expect(container.textContent).toContain("Calling tool");
	});
});

describe("StreamingStatusBar — 位置：跟随输出内容之后", () => {
	it("keeps status bar after the output content (not on top)", () => {
		const blocks: LookUiStreamBlock[] = [
			{ contentIndex: 0, kind: "text", text: "hello", thinking: "", completed: false, uid: 1 },
		];
		const { container } = render(
			<StreamingBlocksBubble blocks={blocks} toolExecutions={{}} isStreaming={true} autoCollapse={false} />,
		);
		const prose = container.querySelector(".message-prose");
		const loader = container.querySelector(".look-cube-loader");
		expect(prose).toBeTruthy();
		expect(loader).toBeTruthy();
		// 正文在前，状态行在其后（DOCUMENT_POSITION_FOLLOWING = 4）
		expect(prose!.compareDocumentPosition(loader!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
	});

	it("renders only the status bar when there are no blocks yet", () => {
		const { container } = render(
			<StreamingBlocksBubble blocks={[]} toolExecutions={{}} isStreaming={true} autoCollapse={false} />,
		);
		expect(container.querySelector(".look-cube-loader")).toBeTruthy();
		expect(container.querySelector(".message-prose")).toBeNull();
	});
});
