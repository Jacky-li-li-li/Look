import type { LookUiEvent } from "@shared/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsAtom, removeAgentAtoms, sessionStateAtomFamily } from "../src/renderer/store/atoms";
import { appStore, initIpcHandlers } from "../src/renderer/store/ipcHandler";
import { flushAllUiEvents } from "../src/renderer/store/ui-event-processor";

const sessionId = "raf-batch-a";

function uiEvent(event: LookUiEvent): { type: "session:ui-event"; sessionId: string; events: LookUiEvent[] } {
	return { type: "session:ui-event", sessionId, events: [event] };
}

let dispose: (() => void) | undefined;

afterEach(() => {
	dispose?.();
	dispose = undefined;
	removeAgentAtoms(sessionId);
	appStore.set(agentsAtom, []);
});

describe("rAF batching — renderer IPC coalescing", () => {
	/**
	 * Verify multiple text_delta events within one tick are coalesced
	 * into a single appStore.set when flushAllUiEvents is called.
	 */
	it("coalesces multiple deltas into a single store write", () => {
		let receive!: (event: any) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: any) => void) {
				receive = callback;
				return () => {};
			},
		});

		// Start streaming
		receive(uiEvent({ type: "run_status", status: "streaming", timestamp: 1 }));
		flushAllUiEvents();

		// Start a text block
		receive(uiEvent({ type: "assistant_text_start", contentIndex: 0, timestamp: 2 }));
		flushAllUiEvents();

		// Fire many deltas WITHOUT flushing in between — simulates rapid token arrival
		const words = ["The", " ", "quick", " ", "brown", " ", "fox", " ", "jumps"];
		for (const word of words) {
			receive(uiEvent({ type: "assistant_text_delta", contentIndex: 0, delta: word, timestamp: 3 }));
		}

		// Now flush — all deltas should have been accumulated in the queue
		flushAllUiEvents();

		const state = appStore.get(sessionStateAtomFamily(sessionId));
		const block = state.uiBlocks.find((b) => b.contentIndex === 0 && b.kind === "text");
		expect(block).toBeDefined();
		expect(block!.text).toBe("The quick brown fox jumps");
		expect(block!.completed).toBe(false);
	});

	/**
	 * Verify that terminal events (run_status idle) flush immediately,
	 * even when there are pending events in the queue.
	 */
	it("flushes immediately on terminal run_status idle", () => {
		let receive!: (event: any) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: any) => void) {
				receive = callback;
				return () => {};
			},
		});

		receive(uiEvent({ type: "run_status", status: "streaming", timestamp: 1 }));
		flushAllUiEvents();

		receive(uiEvent({ type: "assistant_text_start", contentIndex: 0, timestamp: 2 }));
		flushAllUiEvents();

		// Enqueue some deltas
		receive(uiEvent({ type: "assistant_text_delta", contentIndex: 0, delta: "Hello", timestamp: 3 }));

		// Terminal event: run_status idle — should flush pending deltas first,
		// then preserve the completed projection until the snapshot arrives.
		receive(uiEvent({ type: "run_status", status: "idle", timestamp: 4 }));

		// The immediate flush should have processed everything.
		// No need to call flushAllUiEvents — terminal events flush inline.
		const state = appStore.get(sessionStateAtomFamily(sessionId));
		expect(state.uiPhase).toBe("idle");
		expect(state.uiBlocks.length).toBe(1);
		expect(state.uiBlocks[0]?.text).toBe("Hello");
	});

	/**
	 * Verify that the store write count is reduced compared to
	 * per-event writes. We spy on appStore.set and count calls.
	 */
	it("reduces appStore.set calls vs per-event dispatch", () => {
		const setSpy = vi.spyOn(appStore, "set");

		let receive!: (event: any) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: any) => void) {
				receive = callback;
				return () => {};
			},
		});

		// Fire 20 deltas without intermediate flushes
		receive(uiEvent({ type: "run_status", status: "streaming", timestamp: 1 }));
		flushAllUiEvents();
		const afterStreaming = setSpy.mock.calls.length;

		receive(uiEvent({ type: "assistant_text_start", contentIndex: 0, timestamp: 2 }));
		flushAllUiEvents();
		const afterStart = setSpy.mock.calls.length;

		// 20 deltas — all enqueued, not yet flushed
		for (let i = 0; i < 20; i++) {
			receive(uiEvent({ type: "assistant_text_delta", contentIndex: 0, delta: "x", timestamp: 3 }));
		}
		const afterDeltasEnqueued = setSpy.mock.calls.length;

		// No additional set calls should have happened — events are just enqueued
		expect(afterDeltasEnqueued).toBe(afterStart);

		// Now flush — all 20 deltas processed in ONE batch → at most 1 set call
		flushAllUiEvents();
		const afterFlush = setSpy.mock.calls.length;

		// The flush processes the 20 deltas + any agentFlags side effects.
		// Key assertion: the number of NEW set calls is far fewer than 20.
		const newCalls = afterFlush - afterDeltasEnqueued;
		expect(newCalls).toBeLessThanOrEqual(2); // 1 for session state, 0-1 for agent flags

		// Verify the text is correct
		const state = appStore.get(sessionStateAtomFamily(sessionId));
		const block = state.uiBlocks.find((b) => b.contentIndex === 0 && b.kind === "text");
		expect(block!.text).toBe("x".repeat(20));

		setSpy.mockRestore();
	});

	/**
	 * Verify that flushAllUiEvents is idempotent when called
	 * on an already-drained queue.
	 */
	it("flushAllUiEvents is idempotent on empty queue", () => {
		let receive!: (event: any) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: any) => void) {
				receive = callback;
				return () => {};
			},
		});

		receive(uiEvent({ type: "run_status", status: "streaming", timestamp: 1 }));
		flushAllUiEvents();
		flushAllUiEvents(); // second flush should be no-op

		const state = appStore.get(sessionStateAtomFamily(sessionId));
		expect(state.uiPhase).toBe("streaming");
	});
});
