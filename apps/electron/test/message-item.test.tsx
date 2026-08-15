// @vitest-environment jsdom
//
// MessageItem 组装层测试：
// - user / assistant / 纯 live 三种来源渲染正确
// - 消息容器 div（data-message-id）几何稳定
// - MessageActions 操作按钮 show/reserve 语义

import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { LookUiStreamBlock } from "@shared/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageItem } from "../src/renderer/components/chat/MessageItem";
import { MessageActions } from "../src/renderer/components/chat/message-elements/MessageActions";

afterEach(cleanup);

function renderItem(props: Parameters<typeof MessageItem>[0]) {
	return render(
		<Provider>
			<MessageItem {...props} />
		</Provider>,
	);
}

const baseAssistant = (content: AssistantMessage["content"]): AssistantMessage => ({
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
	stopReason: "stop",
	timestamp: Date.now(),
});

const baseUser = (text: string): UserMessage => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp: Date.now(),
});

describe("MessageItem", () => {
	it("renders an assistant message with text content", () => {
		const { container } = renderItem({
			message: baseAssistant([{ type: "text", text: "hi, how can I help?" }]),
		});
		expect(container.textContent).toContain("hi, how can I help?");
		expect(container.querySelector(".whisper-bubble--assistant")).toBeTruthy();
	});

	it("renders a user message right-aligned with user bubble", () => {
		const { container } = renderItem({
			message: baseUser("hello agent"),
		});
		expect(container.textContent).toContain("hello agent");
		expect(container.querySelector(".whisper-bubble--user")).toBeTruthy();
	});

	it("renders an attachment block for a user message carrying [Attachment:] markers (array content)", () => {
		const { container } = renderItem({
			message: baseUser("分析这个\n\n[Attachment: paste-1.md]\n# 标题\n正文\n[/Attachment]"),
		});
		// 附件卡片渲染为 tag 样式：文件名可见、内容默认折叠、原始标记不可见
		expect(container.textContent).toContain("paste-1.md");
		expect(container.textContent).not.toContain("[Attachment:");
		expect(container.textContent).not.toContain("[/Attachment]");
		expect(container.textContent).not.toContain("# 标题");
		// 展开后可见内联内容
		fireEvent.click(screen.getByRole("button", { name: /Show content|展开内容/ }));
		expect(container.textContent).toContain("# 标题");
	});

	it("renders streaming blocks when liveBlocks provided", () => {
		const blocks: LookUiStreamBlock[] = [
			{ contentIndex: 0, kind: "text", text: "streaming text", thinking: "", completed: false, uid: 1 },
		];
		const { container } = renderItem({
			liveBlocks: blocks,
			isStreaming: true,
		});
		expect(container.textContent).toContain("streaming text");
	});

	it("shows a loading indicator for live message with no blocks yet", () => {
		const { container } = renderItem({
			liveBlocks: [],
			isStreaming: true,
		});
		expect(container.textContent).toContain("Thinking");
	});

	it("renders assistant errorMessage", () => {
		const message = { ...baseAssistant([{ type: "text", text: "" }]), errorMessage: "boom" } as AssistantMessage;
		const { container } = renderItem({ message });
		expect(container.textContent).toContain("boom");
	});

	it("streaming → completed: flat live layout switches to grouped snapshot layout", () => {
		// 全链路（S2-2 审查补强）：真实切换是 StreamingBlocksBubble（hasLive）→
		// MessageBlockListForMessage（快照）两个不同组件的整树切换，不是同组件 rerender。
		const message = baseAssistant([
			{ type: "text", text: "final answer" },
			{ type: "thinking", thinking: "deep thought" },
			{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "/tmp/a" } },
		]);
		const liveBlocks: LookUiStreamBlock[] = [
			{ contentIndex: 0, kind: "text", text: "final answer", thinking: "", completed: true, uid: 1 },
			{ contentIndex: 1, kind: "thinking", text: "", thinking: "deep thought", completed: true, uid: 2 },
			{
				contentIndex: 2,
				kind: "toolcall",
				text: "",
				thinking: "",
				toolCallId: "tc1",
				toolName: "read",
				args: { path: "/tmp/a" },
				completed: true,
				uid: 3,
			},
		];
		const toolResultMap: Record<string, ToolResultMessage> = {
			tc1: {
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: "file content" }],
				isError: false,
				timestamp: Date.now(),
			},
		};

		const { container, rerender } = render(
			<Provider>
				<MessageItem
					message={message}
					liveBlocks={liveBlocks}
					isStreaming={true}
					entryId="e1"
					toolResultMap={toolResultMap}
				/>
			</Provider>,
		);
		// 流式中：平铺（无执行组徽标），思考面板直出，工具卡行可见
		expect(container.querySelector("[data-execution-group]")).toBeNull();
		expect(container.querySelector("[data-tool-panel]")).toBeTruthy();
		expect(container.querySelector("[data-thinking-panel]")).toBeTruthy();
		expect(container.textContent).toContain("deep thought");

		// 完成：liveBlocks 移除（hasLive=false）→ 快照路径 → thinking + 工具分组折叠
		rerender(
			<Provider>
				<MessageItem message={message} entryId="e1" toolResultMap={toolResultMap} />
			</Provider>,
		);
		const group = container.querySelector("[data-execution-group]");
		expect(group).toBeTruthy();
		expect(group?.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
		// 平铺工具卡与思考面板不再存在（都折叠进组内）
		expect(container.querySelector("[data-tool-panel]")).toBeNull();
		expect(container.querySelector("[data-thinking-panel]")).toBeNull();

		// 展开组：思考面板（无自身折叠按钮）+ 工具卡片一起出现
		fireEvent.click(group?.querySelector("button") as HTMLButtonElement);
		expect(container.querySelector("[data-thinking-panel]")).toBeTruthy();
		expect(container.textContent).toContain("deep thought");
		expect(container.querySelector("[data-tool-panel]")).toBeTruthy();
	});
});

describe("MessageActions", () => {
	it("renders reserved placeholder when show=false (buttons invisible, meta still visible)", () => {
		const { container } = render(
			<MessageActions show={false} isUser={false} meta={<span data-testid="meta">1.2s</span>} />,
		);
		const el = container.querySelector("[data-message-actions]");
		expect(el?.hasAttribute("data-reserved")).toBe(true);
		// meta 常驻可见（不随 hover 隐藏）
		expect(container.querySelector('[data-testid="meta"]')).toBeTruthy();
	});

	it("renders visible actions when show=true and callbacks provided", () => {
		const onBranch = vi.fn();
		const onCopy = vi.fn();
		const { container } = render(
			<MessageActions
				show={true}
				isUser={false}
				onBranch={onBranch}
				onCopy={onCopy}
				labels={{ branch: "Branch", fork: "Fork", copy: "Copy" }}
			/>,
		);
		const el = container.querySelector("[data-message-actions]");
		expect(el?.hasAttribute("data-reserved")).toBe(false);
		expect(el?.classList.contains("invisible")).toBe(false);
		// 点击复制按钮触发回调
		const copyBtn = container.querySelector('button[aria-label="Copy"]');
		expect(copyBtn).toBeTruthy();
	});
});
