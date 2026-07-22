// @vitest-environment jsdom
//
// Conversation 原语的滚动状态机回归测试。

class ResizeObserverMock {
	static instances: ResizeObserverMock[] = [];
	readonly callback: ResizeObserverCallback;
	target: Element | null = null;

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		ResizeObserverMock.instances.push(this);
	}

	observe(target: Element): void {
		this.target = target;
	}
	unobserve(): void {}
	disconnect(): void {}

	trigger(): void {
		this.callback([], this as unknown as ResizeObserver);
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

function flushFrames(): void {
	const frames = [...pendingFrames.entries()];
	pendingFrames.clear();
	for (const [, callback] of frames) callback(performance.now());
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

function renderHarness(): {
	scroller: HTMLDivElement;
	metrics: ScrollMetrics;
	observer: ResizeObserverMock;
} {
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
	act(flushFrames);
	const observer = ResizeObserverMock.instances.at(-1);
	if (!observer) throw new Error("ResizeObserver missing");
	return { scroller, metrics, observer };
}

beforeEach(() => {
	ResizeObserverMock.instances = [];
	pendingFrames.clear();
});

afterEach(() => {
	cleanup();
	pendingFrames.clear();
});

describe("ConversationScrollButton", () => {
	it("is a named export from conversation.tsx", () => {
		expect(typeof ConversationScrollButton).toBe("function");
	});
});

describe("Conversation streaming follow", () => {
	it("keeps following after a transient non-bottom scroll event caused by layout growth", () => {
		const { scroller, metrics, observer } = renderHarness();
		expect(metrics.scrollTop).toBe(400);

		metrics.scrollHeight = 700;
		fireEvent.scroll(scroller);
		expect(screen.getByTestId("bottom-state").textContent).toBe("false");

		act(() => {
			observer.trigger();
			flushFrames();
		});
		expect(metrics.scrollTop).toBe(500);
		expect(screen.getByTestId("bottom-state").textContent).toBe("true");
	});

	it("stops for an intentional upward wheel and resumes when the user returns to the bottom", () => {
		const { scroller, metrics, observer } = renderHarness();

		fireEvent.wheel(scroller, { deltaY: -48 });
		metrics.scrollTop = 280;
		fireEvent.scroll(scroller);
		metrics.scrollHeight = 700;
		act(() => {
			observer.trigger();
			flushFrames();
		});
		expect(metrics.scrollTop).toBe(280);
		expect(screen.getByTestId("bottom-state").textContent).toBe("false");

		metrics.scrollTop = 500;
		fireEvent.scroll(scroller);
		metrics.scrollHeight = 760;
		act(() => {
			observer.trigger();
			flushFrames();
		});
		expect(metrics.scrollTop).toBe(560);
		expect(screen.getByTestId("bottom-state").textContent).toBe("true");
	});

	it("force-scroll re-enables following after position restoration disabled it", () => {
		const { metrics, observer } = renderHarness();
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		metrics.scrollHeight = 700;
		act(() => {
			observer.trigger();
			flushFrames();
		});
		expect(metrics.scrollTop).toBe(400);

		fireEvent.click(screen.getByRole("button", { name: "Force bottom" }));
		act(flushFrames);
		expect(metrics.scrollTop).toBe(500);
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
