// @vitest-environment jsdom
//
// MessageTicks 垂直刻度组件测试：
// - userMessagePreview 纯函数提取逻辑（string / blocks / 图片-only / 非 user）
// - 渲染/隐藏条件（无 user 消息、不可滚动）
// - 刻度均匀等距排列 + 刻度条高度自适应（min 72 / max 280）
// - 悬停刻度 → 小窗显示预览；鼠标离开延迟后关闭
// - 点击刻度 → onNavigate 回调
//
// 组件数据驱动（不查询 data-message-id），仅可滚动性判断依赖
// scrollHeight/clientHeight（HTMLElement.prototype 注入 mock）；
// Conversation 的 ResizeObserver 保持惰性 stub，避免库动画干扰。

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Conversation, ConversationContent } from "../src/renderer/components/chat/conversation";
import { MessageTicks, type MessageTicksItem, userMessagePreview } from "../src/renderer/components/chat/MessageTicks";
import i18n from "../src/renderer/i18n";

// ── 环境 stub ──
// ResizeObserver / rAF 在每个测试前重新注入（afterEach 会 unstub），
// 保证跨测试隔离且不污染其他文件。

/** 共享滚动指标：测试内可直接改值控制 canScroll */
const metrics = { scrollHeight: 2000, clientHeight: 800, scrollTop: 0 };

/** 每条 data-message-id 节点的 top 偏移（getBoundingClientRect mock 使用） */
const messageTops: Record<string, number> = { m1: 100, m2: 1500 };

function installScrollMetrics(): void {
	Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
		configurable: true,
		get: () => metrics.scrollHeight,
	});
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get: () => metrics.clientHeight,
	});
	Object.defineProperty(HTMLElement.prototype, "scrollTop", {
		configurable: true,
		get: () => metrics.scrollTop,
		set: (value: number) => {
			metrics.scrollTop = value;
		},
	});
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		const id = this.getAttribute?.("data-message-id") ?? "";
		// 模拟真实浏览器：消息节点返回视口坐标（内容坐标 - 已滚动量），
		// 容器（无 data-message-id）视口位置固定，不随内部滚动变化。
		const top = id ? (messageTops[id] ?? 0) - metrics.scrollTop : 0;
		return {
			x: 0,
			y: top,
			top,
			left: 0,
			right: 0,
			bottom: top + 40,
			width: 0,
			height: 40,
			toJSON: () => ({}),
		} as DOMRect;
	});
}

function renderTicks(items: MessageTicksItem[], onNavigate?: (id: string) => void) {
	return render(
		<I18nextProvider i18n={i18n}>
			<Conversation>
				<ConversationContent>
					<div data-message-id="m1">First user message</div>
					<div data-message-id="m2">Second user message</div>
				</ConversationContent>
				<MessageTicks items={items} onNavigate={onNavigate} />
			</Conversation>
		</I18nextProvider>,
	);
}

const userItems: MessageTicksItem[] = [
	{ id: "m1", preview: "First user message" },
	{ id: "m2", preview: "Second user message" },
];

beforeEach(() => {
	metrics.scrollHeight = 2000;
	metrics.clientHeight = 800;
	metrics.scrollTop = 0;
	// 恢复默认消息位置（高亮用例会临时改写）
	messageTops.m1 = 100;
	messageTops.m2 = 1500;
	// 环境 stub（每个测试前重设，afterEach unstub 后仍可靠）
	class ResizeObserverStub {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	}
	vi.stubGlobal("ResizeObserver", ResizeObserverStub);
	// 组件用 rAF 节流 scroll；jsdom 默认无 rAF，注入走 fake setTimeout 的实现
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
		setTimeout(() => callback(performance.now()), 16),
	);
	vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
	installScrollMetrics();
	vi.useFakeTimers();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	// 恢复原型注入的滚动指标，避免污染其他测试
	delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
	delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
	delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTop;
	vi.useRealTimers();
});

// ── userMessagePreview 纯函数 ──

describe("userMessagePreview", () => {
	it("trims string content", () => {
		expect(userMessagePreview({ role: "user", content: "  hello agent  ", timestamp: 1 })).toBe("hello agent");
	});

	it("joins text blocks with newline", () => {
		expect(
			userMessagePreview({
				role: "user",
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				],
				timestamp: 1,
			}),
		).toBe("first\nsecond");
	});

	it("returns empty string for image-only user message", () => {
		expect(
			userMessagePreview({
				role: "user",
				content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
				timestamp: 1,
			}),
		).toBe("");
	});

	it("returns empty string for non-user messages", () => {
		expect(userMessagePreview({ role: "assistant" } as unknown as AgentMessage)).toBe("");
	});
});

// ── 渲染 / 隐藏条件 ──

describe("MessageTicks render conditions", () => {
	it("renders one tick per user message when scrollable", () => {
		const { container } = renderTicks(userItems);
		const ticks = container.querySelectorAll("[data-tick-id]");
		expect(ticks.length).toBe(2);
		// 均匀等距排列：2 条 → 25% / 75%
		expect((ticks[0] as HTMLElement).style.top).toBe("calc(25% - 1.5px)");
		expect((ticks[1] as HTMLElement).style.top).toBe("calc(75% - 1.5px)");
	});

	it("renders nothing when there are no user messages", () => {
		const { container } = renderTicks([]);
		expect(container.querySelector(".message-ticks")).toBeNull();
	});

	it("renders nothing when content is not scrollable", () => {
		metrics.scrollHeight = 800; // ≈ clientHeight → 不可滚动
		const { container } = renderTicks(userItems);
		expect(container.querySelector(".message-ticks")).toBeNull();
	});

	it("is data-driven: renders all items even without matching DOM anchors", () => {
		const { container } = renderTicks([
			{ id: "m1", preview: "First user message" },
			{ id: "no-such-node", preview: "No DOM node" },
		]);
		const ticks = container.querySelectorAll("[data-tick-id]");
		expect(ticks.length).toBe(2);
	});
});

// ── 刻度条尺寸 ──

describe("MessageTicks bar sizing", () => {
	it("clamps bar height to minimum when few messages", () => {
		const { container } = renderTicks([{ id: "m1", preview: "one" }]);
		const bar = container.querySelector(".message-ticks-bar") as HTMLElement;
		expect(bar.style.height).toBe("32px");
	});

	it("grows with message count up to max height", () => {
		const items = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, preview: `msg ${i}` }));
		const { container } = renderTicks(items);
		const bar = container.querySelector(".message-ticks-bar") as HTMLElement;
		expect(bar.style.height).toBe("100px");

		const many = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, preview: `msg ${i}` }));
		const { container: c2 } = renderTicks(many);
		const bar2 = c2.querySelector(".message-ticks-bar") as HTMLElement;
		expect(bar2.style.height).toBe("280px");
	});
});

// ── 当前消息高亮（视口内可见）──

describe("MessageTicks current highlight", () => {
	it("highlights all user messages visible in the viewport and updates on scroll", () => {
		const { container } = renderTicks(userItems);
		const t1 = container.querySelector('[data-tick-id="m1"]') as HTMLElement;
		const t2 = container.querySelector('[data-tick-id="m2"]') as HTMLElement;

		// scrollTop=0，视口 [0, 800]：m1（100-140）可见 → 高亮；m2（1500-1540）不可见 → 不高亮
		expect(t1.classList.contains("bg-foreground")).toBe(true);
		expect(t2.classList.contains("bg-foreground")).toBe(false);

		// 滚动到接近底部 → 视口 [1200, 2000]：m2 可见、m1 不可见 → 高亮切到 m2
		// （scroll 走 rAF 节流，需 flush 一帧）
		act(() => {
			metrics.scrollTop = 1200;
			const scroller = container.querySelector('[class*="overflow-auto"]') as HTMLElement;
			fireEvent.scroll(scroller);
			vi.advanceTimersByTime(20);
		});
		expect(t2.classList.contains("bg-foreground")).toBe(true);
		expect(t1.classList.contains("bg-foreground")).toBe(false);
	});

	it("highlights multiple ticks when several user messages are visible at once", () => {
		// m2 移到视口内（500-540 < 800）→ 与 m1 同时可见，两个刻度都高亮
		messageTops.m2 = 500;
		const { container } = renderTicks(userItems);
		const t1 = container.querySelector('[data-tick-id="m1"]') as HTMLElement;
		const t2 = container.querySelector('[data-tick-id="m2"]') as HTMLElement;
		expect(t1.classList.contains("bg-foreground")).toBe(true);
		expect(t2.classList.contains("bg-foreground")).toBe(true);
	});

	it("does not highlight ticks outside the viewport", () => {
		messageTops.m1 = 10_000; // 把 m1 放到视口外
		messageTops.m2 = 100; // m2 留在视口内
		const { container } = renderTicks(userItems);
		const t1 = container.querySelector('[data-tick-id="m1"]') as HTMLElement;
		const t2 = container.querySelector('[data-tick-id="m2"]') as HTMLElement;
		expect(t1.classList.contains("bg-foreground")).toBe(false);
		expect(t2.classList.contains("bg-foreground")).toBe(true);
	});
});

// ── 悬停小窗 ──

describe("MessageTicks hover popup", () => {
	it("shows the user message preview on tick hover and closes after leave delay", () => {
		const { container } = renderTicks(userItems);
		const tick = container.querySelector('[data-tick-id="m1"]') as HTMLElement;

		fireEvent.mouseEnter(tick);
		const popup = container.querySelector("[class*='popover']") as HTMLElement;
		expect(popup).toBeTruthy();
		expect(within(popup).getByText("First user message")).toBeTruthy();

		fireEvent.mouseLeave(tick);
		// 离开后短暂延迟内仍显示（桥接窗口）
		expect(within(popup).getByText("First user message")).toBeTruthy();
		act(() => {
			vi.advanceTimersByTime(130);
		});
		expect(container.querySelector("[class*='popover']")).toBeNull();
	});

	it("keeps the popup open when moving into it (hover bridge)", () => {
		const { container } = renderTicks(userItems);
		const tick = container.querySelector('[data-tick-id="m1"]') as HTMLElement;
		fireEvent.mouseEnter(tick);
		const popup = container.querySelector("[class*='popover']") as HTMLElement;

		// 离开刻度但进入小窗 → 定时器被取消，不关闭
		fireEvent.mouseLeave(tick);
		fireEvent.mouseEnter(popup);
		act(() => {
			vi.advanceTimersByTime(130);
		});
		expect(within(popup).getByText("First user message")).toBeTruthy();
	});

	it("shows image-only placeholder for empty preview", () => {
		const { container } = renderTicks([{ id: "m1", preview: "" }]);
		const tick = container.querySelector('[data-tick-id="m1"]') as HTMLElement;
		fireEvent.mouseEnter(tick);
		const popup = container.querySelector("[class*='popover']") as HTMLElement;
		expect(within(popup).getByText("🖼️ Image message")).toBeTruthy();
	});
});

// ── 点击跳转 ──

describe("MessageTicks click navigation", () => {
	it("calls onNavigate with the tick id and closes the popup", () => {
		const onNavigate = vi.fn();
		const { container } = renderTicks(userItems, onNavigate);
		const tick = container.querySelector('[data-tick-id="m2"]') as HTMLElement;

		fireEvent.mouseEnter(tick);
		const popup = container.querySelector("[class*='popover']") as HTMLElement;
		expect(within(popup).getByText("Second user message")).toBeTruthy();

		fireEvent.click(tick);
		expect(onNavigate).toHaveBeenCalledWith("m2");
		expect(container.querySelector("[class*='popover']")).toBeNull();
	});
});
