// @vitest-environment jsdom
//
// 展开型组件与 scroll-escape 守卫测试：
// CollapsibleExecutionGroup / SubagentToolGroup / ThinkingPanel 在展开时应
// 调用 useConversationContextSafe()?.stopScroll()（鼠标 + 键盘两条路径），
// 防止 stick-to-bottom 的 resize 跟随把视口拽到展开后内容底部；
// 在 Conversation 之外（safe hook 返回 null）应优雅降级不崩溃。

import type { ToolCall } from "@earendil-works/pi-ai";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CollapsibleExecutionGroup from "../src/renderer/components/chat/CollapsibleExecutionGroup";
import SubagentToolGroup from "../src/renderer/components/chat/SubagentToolGroup";
import ThinkingPanel from "../src/renderer/components/chat/ThinkingPanel";
import type { ToolCallViewModel } from "../src/renderer/components/chat/ToolCallCard";

const { mockCtx } = vi.hoisted(() => ({
	mockCtx: { current: null as null | { stopScroll: ReturnType<typeof vi.fn> } },
}));

vi.mock("../src/renderer/components/chat/conversation", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/renderer/components/chat/conversation")>();
	return {
		...actual,
		useConversationContextSafe: () => mockCtx.current,
	};
});

function toolBlocks(n: number): ToolCall[] {
	return Array.from({ length: n }, (_, i) => ({
		type: "toolCall",
		id: `tc${i}`,
		name: "read",
		arguments: { path: `/tmp/${i}` },
	}));
}

const toolCalls: ToolCallViewModel[] = [
	{
		callId: "s1",
		toolName: "subagent",
		args: { agent: "reviewer", title: "审查任务", task: "task" },
		status: "success",
		result: "ok",
		isError: false,
	},
	{
		callId: "s2",
		toolName: "subagent",
		args: { agent: "scout", title: "探索任务", task: "task" },
		status: "success",
		result: "ok",
		isError: false,
	},
];

afterEach(cleanup);

beforeEach(() => {
	mockCtx.current = { stopScroll: vi.fn() };
});

describe("CollapsibleExecutionGroup scroll-escape guard", () => {
	it("calls stopScroll when expanding via mouse click", () => {
		render(<CollapsibleExecutionGroup blocks={toolBlocks(3)} toolExecutions={{}} isStreaming={false} />);
		const stop = mockCtx.current!.stopScroll;
		const badge = screen.getByRole("button");
		expect(badge.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(badge);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(badge.getAttribute("aria-expanded")).toBe("true");
	});

	it("calls stopScroll when expanding via keyboard (Enter)", () => {
		render(<CollapsibleExecutionGroup blocks={toolBlocks(3)} toolExecutions={{}} isStreaming={false} />);
		const stop = mockCtx.current!.stopScroll;
		fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("calls stopScroll when expanding via keyboard (Space)", () => {
		render(<CollapsibleExecutionGroup blocks={toolBlocks(3)} toolExecutions={{}} isStreaming={false} />);
		const stop = mockCtx.current!.stopScroll;
		fireEvent.keyDown(screen.getByRole("button"), { key: " " });
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("does not call stopScroll again when collapsing", () => {
		render(<CollapsibleExecutionGroup blocks={toolBlocks(3)} toolExecutions={{}} isStreaming={false} />);
		const stop = mockCtx.current!.stopScroll;
		const badge = screen.getByRole("button");
		fireEvent.click(badge); // expand
		expect(stop).toHaveBeenCalledTimes(1);
		fireEvent.click(badge); // collapse
		expect(stop).toHaveBeenCalledTimes(1);
		expect(badge.getAttribute("aria-expanded")).toBe("false");
	});

	it("degrades gracefully without a Conversation provider (null ctx)", () => {
		mockCtx.current = null;
		render(<CollapsibleExecutionGroup blocks={toolBlocks(3)} toolExecutions={{}} isStreaming={false} />);
		const badge = screen.getByRole("button");
		expect(() => fireEvent.click(badge)).not.toThrow();
		expect(badge.getAttribute("aria-expanded")).toBe("true");
		expect(() => fireEvent.keyDown(badge, { key: "Enter" })).not.toThrow();
	});
});

describe("SubagentToolGroup scroll-escape guard", () => {
	// 头部折叠开关是带 aria-expanded 的按钮（subagent 卡片自身也有按钮）
	const headerButton = () => screen.getAllByRole("button").find((b) => b.hasAttribute("aria-expanded"));

	it("calls stopScroll when re-expanding after collapse", () => {
		render(<SubagentToolGroup calls={toolCalls} />);
		const stop = mockCtx.current!.stopScroll;
		const header = headerButton()!;
		fireEvent.click(header); // collapse
		expect(stop).not.toHaveBeenCalled();
		fireEvent.click(header); // re-expand
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("degrades gracefully without a Conversation provider", () => {
		mockCtx.current = null;
		render(<SubagentToolGroup calls={toolCalls} />);
		const header = headerButton()!;
		expect(() => fireEvent.click(header)).not.toThrow();
	});
});

describe("ThinkingPanel scroll-escape guard", () => {
	it("calls stopScroll when expanding a collapsed panel", () => {
		render(<ThinkingPanel thinking="long thinking content" isStreaming={false} autoCollapse={true} />);
		const stop = mockCtx.current!.stopScroll;
		const header = screen.getByRole("button");
		fireEvent.click(header); // expand (autoCollapse=true → initially collapsed)
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("does not call stopScroll when collapsing", () => {
		render(<ThinkingPanel thinking="content" isStreaming={false} autoCollapse={false} />);
		const stop = mockCtx.current!.stopScroll;
		const header = screen.getByRole("button");
		fireEvent.click(header); // collapse (autoCollapse=false → initially expanded)
		expect(stop).not.toHaveBeenCalled();
	});

	it("degrades gracefully without a Conversation provider", () => {
		mockCtx.current = null;
		render(<ThinkingPanel thinking="content" isStreaming={false} autoCollapse={true} />);
		const header = screen.getByRole("button");
		expect(() => fireEvent.click(header)).not.toThrow();
	});
});
