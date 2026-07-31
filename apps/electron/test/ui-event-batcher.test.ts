// ============================================================
// UIEventBatcher 行为测试
//
// 覆盖两阶段时间窗批处理：
//   1. 首事件后 1ms probe 窗口：无后续事件 → 立即 flush
//   2. 第二事件到达 → 提升为 8ms 批量窗口
//   3. flush 清空缓冲并 emit 一个批次
//   4. clear 在销毁清理时丢弃缓冲
// ============================================================

import type { LookUiEvent } from "@look/shared/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IEventBus, ISessionScope } from "../src/main/core/contracts.js";
import { UIEventBatcher } from "../src/main/session/events/ui-event-batcher.js";

function makeScope(sessionId = "session-1"): ISessionScope {
	return {
		sessionId,
		projectId: "project-1",
		uiEventBuffer: [],
		uiEventFlushTimer: null,
		uiEventFirstTimer: null,
		translationTracker: {
			activeTextIndices: new Set(),
			activeThinkingIndices: new Set(),
			activeToolCallIndices: new Set(),
		},
		isDefaultName: false,
		turnStartedAt: null,
	};
}

function makeBatcher(): { batcher: UIEventBatcher; emitted: unknown[]; eventBus: IEventBus } {
	const emitted: unknown[] = [];
	const eventBus: IEventBus = {
		emit: vi.fn((event) => emitted.push(event)),
	} as unknown as IEventBus;
	return { batcher: new UIEventBatcher(eventBus), emitted, eventBus };
}

function event(type: string, timestamp = 0): LookUiEvent {
	return { type, timestamp } as unknown as LookUiEvent;
}

describe("UIEventBatcher", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("flushes a single event quickly through the 1ms probe window", () => {
		vi.useFakeTimers();
		const { batcher, emitted } = makeBatcher();
		const scope = makeScope();
		batcher.bufferUiEvents(scope, [event("assistant_text_delta")]);

		expect(emitted).toHaveLength(0);
		vi.advanceTimersByTime(2);
		expect(emitted).toHaveLength(1);
		const batch = emitted[0] as { type: string; events: LookUiEvent[] };
		expect(batch.type).toBe("session:ui-event");
		expect(batch.events).toHaveLength(1);
		expect(scope.uiEventBuffer).toHaveLength(0);
	});

	it("coalesces a burst into a single 8ms batch", () => {
		vi.useFakeTimers();
		const { batcher, emitted } = makeBatcher();
		const scope = makeScope();
		batcher.bufferUiEvents(scope, [event("assistant_text_start")]);
		batcher.bufferUiEvents(scope, [event("assistant_text_delta")]);
		batcher.bufferUiEvents(scope, [event("assistant_text_delta")]);

		vi.advanceTimersByTime(1);
		expect(emitted).toHaveLength(0); // promoted to 8ms window, not 1ms
		vi.advanceTimersByTime(8);
		expect(emitted).toHaveLength(1);
		const batch = emitted[0] as { type: string; events: LookUiEvent[] };
		expect(batch.events).toHaveLength(3);
	});

	it("second event during probe promotes the timer instead of double-flushing", () => {
		vi.useFakeTimers();
		const { batcher, emitted } = makeBatcher();
		const scope = makeScope();
		batcher.bufferUiEvents(scope, [event("a")]);
		// Just before the 1ms probe fires, a second event arrives.
		vi.advanceTimersByTime(0.9);
		batcher.bufferUiEvents(scope, [event("b")]);
		vi.advanceTimersByTime(1);
		expect(emitted).toHaveLength(0); // must NOT fire at 1ms
		vi.advanceTimersByTime(8);
		expect(emitted).toHaveLength(1);
		const batch = emitted[0] as { type: string; events: LookUiEvent[] };
		expect(batch.events).toHaveLength(2);
	});

	it("flushUiEventBuffer emits immediately and clears pending timers", () => {
		vi.useFakeTimers();
		const { batcher, emitted } = makeBatcher();
		const scope = makeScope();
		batcher.bufferUiEvents(scope, [event("x")]);
		batcher.flushUiEventBuffer(scope);
		expect(emitted).toHaveLength(1);
		// Advancing timers must not double-emit.
		vi.advanceTimersByTime(20);
		expect(emitted).toHaveLength(1);
	});

	it("flushUiEventBuffer with empty buffer emits nothing", () => {
		const { batcher, emitted } = makeBatcher();
		batcher.flushUiEventBuffer(makeScope());
		expect(emitted).toHaveLength(0);
	});

	it("clearUiEventBuffer drops buffered events without emitting (destroy path)", () => {
		vi.useFakeTimers();
		const { batcher, emitted } = makeBatcher();
		const scope = makeScope();
		batcher.bufferUiEvents(scope, [event("y")]);
		batcher.clearUiEventBuffer(scope);
		expect(scope.uiEventBuffer).toHaveLength(0);
		vi.advanceTimersByTime(20);
		expect(emitted).toHaveLength(0);
	});

	it("buffers are per-session isolated", () => {
		vi.useFakeTimers();
		const { batcher, emitted } = makeBatcher();
		const scopeA = makeScope("session-a");
		const scopeB = makeScope("session-b");
		batcher.bufferUiEvents(scopeA, [event("a1")]);
		batcher.bufferUiEvents(scopeA, [event("a2")]);
		batcher.bufferUiEvents(scopeB, [event("b1")]);
		batcher.flushUiEventBuffer(scopeB);
		expect(emitted).toHaveLength(1);
		const batch = emitted[0] as { sessionId: string; events: LookUiEvent[] };
		expect(batch.sessionId).toBe("session-b");
		expect(batch.events).toHaveLength(1);
	});
});
