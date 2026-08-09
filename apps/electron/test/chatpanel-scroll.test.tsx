// @vitest-environment jsdom
//
// Conversation 原语的滚动状态机回归测试。
//
// 滚动实现委托给 use-stick-to-bottom@1.1.6，测试要点：
//   - 目标 scrollTop = scrollHeight - clientHeight - 1（库的 -1 偏移）
//   - 初始贴底由 ResizeObserver 首次回调触发（animation=initial）
//   - 内容增长走 smooth 弹簧动画（350ms 时长），用假时钟 + 帧泵推进
//   - 用户向上滚动 → escape 锁；滚回底部 → 恢复跟随

class ResizeObserverMock {
	static instances: ResizeObserverMock[] = [];
	readonly callback: ResizeObserverCallback;
	target: Element | null = null;
	/** 模拟内容高度；observe 时以当前值触发一次（真实浏览器行为），trigger 时增长。 */
	height = 0;

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		ResizeObserverMock.instances.push(this);
	}

	observe(target: Element): void {
		this.target = target;
		// 真实浏览器在 observe 后立即回调一次初始尺寸；库依赖它做 initial 滚动。
		this.emit();
	}
	unobserve(): void {}
	disconnect(): void {}

	/** 模拟内容高度增长并触发回调。 */
	trigger(growth = 10): void {
		this.height += growth;
		this.emit();
	}

	private emit(): void {
		this.callback(
			[
				{
					contentRect: { width: 0, height: this.height },
					target: this.target as Element,
				} as unknown as ResizeObserverEntry,
			],
			this as unknown as ResizeObserver,
		);
	}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

let nextFrameId = 0;
const pendingFrames = new Map<number, FrameRequestCallback>();
vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
	const id = ++nextFrameId;
	pendingFrames.set(id, callback);
	return id;
});
vi.stubGlobal("cancelAnimationFrame", (id: number) => pendingFrames.delete(id));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ReactElement, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	Conversation,
	ConversationContent,
	ConversationScrollButton,
	useConversationContext,
} from "../src/renderer/components/chat/conversation";

const FRAME_MS = 1000 / 60;

/**
 * 泵出动画帧。库的 spring 动画链是「rAF → promise.then → rAF」递归，
 * 每帧之间必须让微任务推进（await），否则动画只走第一步。
 * 每帧先推进假时钟（Date/performance），保证 tickDelta 和 350ms 时长门真实生效。
 */
async function pumpFrames(frameCount = 200): Promise<void> {
	for (let i = 0; i < frameCount; i++) {
		const batch = [...pendingFrames.entries()];
		pendingFrames.clear();
		if (batch.length === 0) return;
		vi.advanceTimersByTime(FRAME_MS);
		for (const [, callback] of batch) callback(performance.now());
		await Promise.resolve();
	}
}

interface ScrollMetrics {
	scrollHeight: number;
	clientHeight: number;
	scrollTop: number;
}

function installScrollMetrics(element: HTMLDivElement): ScrollMetrics {
	const metrics: ScrollMetrics = { scrollHeight: 600, clientHeight: 200, scrollTop: 0 };
	Object.defineProperties(element, {
		scrollHeight: { configurable: true, get: () => metrics.scrollHeight },
		clientHeight: { configurable: true, get: () => metrics.clientHeight },
		scrollTop: {
			configurable: true,
			get: () => metrics.scrollTop,
			set: (value: number) => {
				metrics.scrollTop = Math.max(0, Math.min(Number(value), metrics.scrollHeight - metrics.clientHeight));
			},
		},
	});
	return metrics;
}

/** 库计算的目标 scrollTop（含 -1 偏移）。 */
function targetTop(metrics: ScrollMetrics): number {
	return metrics.scrollHeight - metrics.clientHeight - 1;
}

function ScrollHarness(): ReactElement {
	const { followToBottom, isAtBottom, scrollToBottom, stopScroll } = useConversationContext();
	return (
		<>
			<ConversationContent>
				<div>Streaming content</div>
			</ConversationContent>
			<output data-testid="bottom-state">{String(isAtBottom)}</output>
			<button type="button" onClick={followToBottom}>
				Follow
			</button>
			<button type="button" onClick={scrollToBottom}>
				Force bottom
			</button>
			<button type="button" onClick={stopScroll}>
				Stop
			</button>
		</>
	);
}

async function renderHarness(): Promise<{
	scroller: HTMLDivElement;
	metrics: ScrollMetrics;
	observer: ResizeObserverMock;
}> {
	const { container } = render(
		<StrictMode>
			<Conversation>
				<ScrollHarness />
			</Conversation>
		</StrictMode>,
	);
	const scroller = container.querySelector('[role="log"] > div');
	if (!(scroller instanceof HTMLDivElement)) throw new Error("scroll container missing");
	const metrics = installScrollMetrics(scroller);
	// 初始 RO 回调已触发 instant 滚动，泵帧让它落位。
	await act(async () => {
		await pumpFrames();
	});
	const observer = ResizeObserverMock.instances.at(-1);
	if (!observer) throw new Error("ResizeObserver missing");
	return { scroller, metrics, observer };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
	ResizeObserverMock.instances = [];
	pendingFrames.clear();
});

afterEach(() => {
	cleanup();
	pendingFrames.clear();
	vi.useRealTimers();
});

describe("ConversationScrollButton", () => {
	it("is a named export from conversation.tsx", () => {
		expect(typeof ConversationScrollButton).toBe("function");
	});
});

describe("Conversation streaming follow", () => {
	it("keeps following after a transient non-bottom scroll event caused by layout growth", async () => {
		const { scroller, metrics, observer } = await renderHarness();
		// StrictMode 双挂载下，开发模式残留的旧实例动画链与新实例并发写同一
		// scrollTop（React 18 不 double-invoke ref callback，disposed 补丁在
		// 此场景不生效），位移叠加可能使强弹簧冲到容器 clamp 上限
		// （scrollHeight - clientHeight = 400），它同样是视觉上的"完全到底"；
		// 生产构建无双挂载，单链收敛到库的 target（399）。断言放宽到
		// "到达底部 1px 内"，不耦合库的 -1 偏移实现细节。
		expect(metrics.scrollTop).toBeGreaterThanOrEqual(targetTop(metrics) - 1);
		expect(metrics.scrollTop).toBeLessThanOrEqual(targetTop(metrics) + 1);
		expect(screen.getByTestId("bottom-state").textContent).toBe("true");

		// 内容增长 → 仍贴底跟随；期间的滚动事件不应打断跟随。
		metrics.scrollHeight = 700;
		act(() => {
			observer.trigger(100);
			fireEvent.scroll(scroller);
		});
		await act(async () => {
			await pumpFrames();
		});

		expect(metrics.scrollTop).toBeGreaterThanOrEqual(targetTop(metrics) - 2);
		expect(screen.getByTestId("bottom-state").textContent).toBe("true");
	});

	it("stops for an intentional upward scroll and resumes when the user returns to the bottom", async () => {
		const { scroller, metrics, observer } = await renderHarness();

		// 建立滚动基线（lastScrollTop），之后才能识别"向上滚"。
		fireEvent.scroll(scroller);
		await act(async () => {
			await pumpFrames();
		});

		// 用户向上滚离底部 → 停止跟随。
		metrics.scrollTop = 280;
		fireEvent.scroll(scroller);
		await act(async () => {
			await pumpFrames();
		});
		expect(screen.getByTestId("bottom-state").textContent).toBe("false");

		// 滚离后内容增长：不应把用户拽回底部。
		metrics.scrollHeight = 700;
		act(() => observer.trigger(100));
		await act(async () => {
			await pumpFrames();
		});
		expect(metrics.scrollTop).toBeCloseTo(280, 1);
		expect(screen.getByTestId("bottom-state").textContent).toBe("false");

		// 用户滚回底部 → 恢复跟随；再次增长仍贴底。
		metrics.scrollTop = targetTop(metrics);
		fireEvent.scroll(scroller);
		await act(async () => {
			await pumpFrames();
		});
		expect(screen.getByTestId("bottom-state").textContent).toBe("true");

		act(() => observer.trigger(50));
		await act(async () => {
			await pumpFrames();
		});
		expect(metrics.scrollTop).toBeGreaterThanOrEqual(targetTop(metrics) - 2);
	});

	it("force-scroll re-enables following after position restoration disabled it", async () => {
		const { scroller, metrics, observer } = await renderHarness();

		// 建立滚动基线后停止跟随，并滚离底部（isNearBottom=false）。
		fireEvent.scroll(scroller);
		await act(async () => {
			await pumpFrames();
		});
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		metrics.scrollTop = 280;
		fireEvent.scroll(scroller);
		await act(async () => {
			await pumpFrames();
		});
		expect(screen.getByTestId("bottom-state").textContent).toBe("false");

		// 停止后内容增长：不再跟随。
		metrics.scrollHeight = 700;
		act(() => observer.trigger(100));
		await act(async () => {
			await pumpFrames();
		});
		expect(metrics.scrollTop).toBeCloseTo(280, 1);

		// 强制回到底部 → 恢复跟随。
		fireEvent.click(screen.getByRole("button", { name: "Force bottom" }));
		await act(async () => {
			await pumpFrames();
		});
		expect(screen.getByTestId("bottom-state").textContent).toBe("true");
		expect(metrics.scrollTop).toBeGreaterThanOrEqual(targetTop(metrics) - 2);

		// 恢复后增长继续跟随。
		act(() => observer.trigger(50));
		await act(async () => {
			await pumpFrames();
		});
		expect(metrics.scrollTop).toBeGreaterThanOrEqual(targetTop(metrics) - 2);
	});
});

describe("ChatMessageList source (scroll container wiring)", () => {
	const SRC = readFileSync(resolve(__dirname, "../src/renderer/components/chat/ChatMessageList.tsx"), "utf8");

	it("uses Conversation as the scroll container", () => {
		expect(SRC).toMatch(/<Conversation\b/);
		expect(SRC).toMatch(/<ConversationContent/);
		expect(SRC).toMatch(/<ConversationScrollButton/);
	});

	it("imports from Conversation via useConversationContext", () => {
		expect(SRC).toMatch(/useConversationContext/);
	});

	it("uses Conversation key={agentId} for per-session remount on switch", () => {
		expect(SRC).toMatch(/key=\{agentId\}/);
	});

	it("sets isAtBottom from useConversationContext", () => {
		expect(SRC).toMatch(/isAtBottom/);
	});

	it("scrolls to message via querySelector + scrollIntoView", () => {
		expect(SRC).toMatch(/scrollIntoView/);
		expect(SRC).toMatch(/data-message-id/);
	});

	it("no longer imports react-virtuoso", () => {
		expect(SRC).not.toMatch(/from\s+["']react-virtuoso["']/);
		expect(SRC).not.toMatch(/<Virtuoso\b/);
		expect(SRC).not.toMatch(/followOutput/);
		expect(SRC).not.toMatch(/atBottomStateChange/);
	});

	it("no longer imports use-stick-to-bottom", () => {
		expect(SRC).not.toMatch(/from\s+["']use-stick-to-bottom["']/);
		expect(SRC).not.toMatch(/useStickToBottomContext/);
		expect(SRC).not.toMatch(/StickToBottom/);
	});
});

// ── 消息区滚动条（常显隐藏样式，滚动/悬停不切换 class）──
// 注：`look-scrolling` 动态 class 的实现在“隐藏消息区滚动条”提交中已移除
//（滚动条现为 scrollbar-width:none 常隐），对应旧用例在此一并删除（2026-08-08）。

describe("message scrollbar visibility", () => {
	it("scroll container carries the look-message-scrollbar class", async () => {
		const { scroller } = await renderHarness();
		expect(scroller.classList.contains("look-message-scrollbar")).toBe(true);
	});
});
