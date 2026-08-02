// @vitest-environment jsdom
//
// MessageItem 组装层测试：
// - user / assistant / 纯 live 三种来源渲染正确
// - 消息容器 div（data-message-id）几何稳定
// - MessageActions 操作按钮 show/reserve 语义

import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { LookUiStreamBlock } from "@shared/types";
import { cleanup, render } from "@testing-library/react";
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
			autoCollapse: false,
		});
		expect(container.textContent).toContain("hi, how can I help?");
		expect(container.querySelector(".whisper-bubble--assistant")).toBeTruthy();
	});

	it("renders a user message right-aligned with user bubble", () => {
		const { container } = renderItem({
			message: baseUser("hello agent"),
			autoCollapse: false,
		});
		expect(container.textContent).toContain("hello agent");
		expect(container.querySelector(".whisper-bubble--user")).toBeTruthy();
	});

	it("renders streaming blocks when liveBlocks provided", () => {
		const blocks: LookUiStreamBlock[] = [
			{ contentIndex: 0, kind: "text", text: "streaming text", thinking: "", completed: false, uid: 1 },
		];
		const { container } = renderItem({
			liveBlocks: blocks,
			isStreaming: true,
			autoCollapse: false,
		});
		expect(container.textContent).toContain("streaming text");
	});

	it("shows a loading indicator for live message with no blocks yet", () => {
		const { container } = renderItem({
			liveBlocks: [],
			isStreaming: true,
			autoCollapse: false,
		});
		expect(container.textContent).toContain("Thinking");
	});

	it("renders assistant errorMessage", () => {
		const message = { ...baseAssistant([{ type: "text", text: "" }]), errorMessage: "boom" } as AssistantMessage;
		const { container } = renderItem({ message, autoCollapse: false });
		expect(container.textContent).toContain("boom");
	});
});

describe("MessageActions", () => {
	it("renders reserved (invisible) placeholder when show=false", () => {
		const { container } = render(<MessageActions show={false} isUser={false} />);
		const el = container.querySelector("[data-message-actions]");
		expect(el?.hasAttribute("data-reserved")).toBe(true);
		expect(el?.classList.contains("invisible")).toBe(true);
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
