import type { LookUiEvent } from "@shared/types";
import { afterEach, describe, expect, it } from "vitest";
import { appStore } from "../src/renderer/store/appStore";
import { removeAgentAtoms } from "../src/renderer/store/atomFamilyRegistry";
import { agentsAtom, sessionStateAtomFamily } from "../src/renderer/store/atoms";
import { initIpcHandlers } from "../src/renderer/store/ipcHandler";
import { deriveActiveQueue, deriveSessionPhase } from "../src/renderer/store/sessionTypes";
import { flushAllUiEvents } from "../src/renderer/store/ui-event-processor";

const sessionId = "ui-store-a";

function uiEvent(event: LookUiEvent): { type: "session:ui-event"; sessionId: string; events: LookUiEvent[] } {
	return { type: "session:ui-event", sessionId, events: [event] };
}

function uiEvents(events: LookUiEvent[]): { type: "session:ui-event"; sessionId: string; events: LookUiEvent[] } {
	return { type: "session:ui-event", sessionId, events };
}

let dispose: (() => void) | undefined;

afterEach(() => {
	dispose?.();
	dispose = undefined;
	removeAgentAtoms(sessionId);
	appStore.set(agentsAtom, []);
});

describe("UI event canonical store (session:ui-event)", () => {
	/** 帧批处理版：receive 后立即 flush 以便同步断言 */
	function flushReceive(receive: (event: MainToRendererEvent) => void, event: MainToRendererEvent) {
		receive(event);
		flushAllUiEvents();
	}

	it("tracks run_status transitions in uiPhase", () => {
		let receive!: (event: MainToRendererEvent) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: MainToRendererEvent) => void) {
				receive = callback;
				return () => {};
			},
		});

		flushReceive(receive, uiEvent({ type: "run_status", status: "streaming", timestamp: 1 }));
		const during = appStore.get(sessionStateAtomFamily(sessionId));
		expect(during.uiPhase).toBe("streaming");
		expect(during.uiBlocks).toEqual([]);

		flushReceive(receive, uiEvent({ type: "run_status", status: "idle", timestamp: 2 }));
		const after = appStore.get(sessionStateAtomFamily(sessionId));
		expect(after.uiPhase).toBe("idle");
	});

	it("accumulates text deltas into uiBlocks", () => {
		let receive!: (event: MainToRendererEvent) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: MainToRendererEvent) => void) {
				receive = callback;
				return () => {};
			},
		});

		flushReceive(receive, uiEvent({ type: "run_status", status: "streaming", timestamp: 1 }));
		flushReceive(receive, uiEvent({ type: "assistant_text_start", contentIndex: 0, timestamp: 2 }));
		flushReceive(receive, uiEvent({ type: "assistant_text_delta", contentIndex: 0, delta: "Hello", timestamp: 3 }));
		flushReceive(receive, uiEvent({ type: "assistant_text_delta", contentIndex: 0, delta: " World", timestamp: 4 }));
		flushReceive(
			receive,
			uiEvent({ type: "assistant_text_end", contentIndex: 0, text: "Hello World", timestamp: 5 }),
		);

		const state = appStore.get(sessionStateAtomFamily(sessionId));
		const block = state.uiBlocks.find((b) => b.contentIndex === 0 && b.kind === "text");
		expect(block).toBeDefined();
		expect(block!.text).toBe("Hello World");
		expect(block!.completed).toBe(true);
	});

	it("preserves text deltas that arrive in the same batch as text_end", () => {
		let receive!: (event: MainToRendererEvent) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: MainToRendererEvent) => void) {
				receive = callback;
				return () => {};
			},
		});

		receive(
			uiEvents([
				{ type: "run_status", status: "streaming", timestamp: 1 },
				{ type: "assistant_text_start", contentIndex: 0, timestamp: 2 },
				{ type: "assistant_text_delta", contentIndex: 0, delta: "Hello", timestamp: 3 },
				{ type: "assistant_text_delta", contentIndex: 0, delta: " World", timestamp: 4 },
				{ type: "assistant_text_end", contentIndex: 0, text: "", timestamp: 5 },
			]),
		);
		flushAllUiEvents();

		const state = appStore.get(sessionStateAtomFamily(sessionId));
		const block = state.uiBlocks.find((b) => b.contentIndex === 0 && b.kind === "text");
		expect(block).toMatchObject({ text: "Hello World", completed: true });
	});

	it("accumulates thinking deltas and marks completed", () => {
		let receive!: (event: MainToRendererEvent) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: MainToRendererEvent) => void) {
				receive = callback;
				return () => {};
			},
		});

		flushReceive(receive, uiEvent({ type: "run_status", status: "streaming", timestamp: 1 }));
		flushReceive(receive, uiEvent({ type: "thinking_start", contentIndex: 0, timestamp: 2 }));
		flushReceive(
			receive,
			uiEvent({ type: "thinking_delta", contentIndex: 0, delta: "Let me think...", timestamp: 3 }),
		);

		const mid = appStore.get(sessionStateAtomFamily(sessionId));
		const midBlock = mid.uiBlocks.find((b) => b.contentIndex === 0 && b.kind === "thinking");
		expect(midBlock).toBeDefined();
		expect(midBlock!.thinking).toBe("Let me think...");
		expect(midBlock!.completed).toBe(false);

		flushReceive(
			receive,
			uiEvent({ type: "thinking_end", contentIndex: 0, thinking: "Let me think...", timestamp: 4 }),
		);
		const end = appStore.get(sessionStateAtomFamily(sessionId));
		const endBlock = end.uiBlocks.find((b) => b.contentIndex === 0 && b.kind === "thinking");
		expect(endBlock!.completed).toBe(true);
	});

	it("preserves thinking deltas that arrive in the same batch as thinking_end", () => {
		let receive!: (event: MainToRendererEvent) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: MainToRendererEvent) => void) {
				receive = callback;
				return () => {};
			},
		});

		receive(
			uiEvents([
				{ type: "run_status", status: "streaming", timestamp: 1 },
				{ type: "thinking_start", contentIndex: 0, timestamp: 2 },
				{ type: "thinking_delta", contentIndex: 0, delta: "Plan", timestamp: 3 },
				{ type: "thinking_delta", contentIndex: 0, delta: " first", timestamp: 4 },
				{ type: "thinking_end", contentIndex: 0, thinking: "", timestamp: 5 },
			]),
		);
		flushAllUiEvents();

		const state = appStore.get(sessionStateAtomFamily(sessionId));
		const block = state.uiBlocks.find((b) => b.contentIndex === 0 && b.kind === "thinking");
		expect(block).toMatchObject({ thinking: "Plan first", completed: true });
	});

	it("tracks tool_call lifecycle in uiBlocks", () => {
		let receive!: (event: MainToRendererEvent) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: MainToRendererEvent) => void) {
				receive = callback;
				return () => {};
			},
		});

		flushReceive(receive, uiEvent({ type: "run_status", status: "streaming", timestamp: 1 }));
		flushReceive(receive, uiEvent({ type: "toolcall_start", contentIndex: 0, timestamp: 2 }));
		flushReceive(
			receive,
			uiEvent({
				type: "toolcall_end",
				contentIndex: 0,
				toolCallId: "tc-1",
				toolName: "read",
				args: { path: "foo.ts" },
				timestamp: 3,
			}),
		);

		const state = appStore.get(sessionStateAtomFamily(sessionId));
		const tc = state.uiBlocks.find((b) => b.contentIndex === 0 && b.kind === "toolcall");
		expect(tc).toBeDefined();
		expect(tc!.toolCallId).toBe("tc-1");
		expect(tc!.toolName).toBe("read");
		expect(tc!.completed).toBe(true);
	});

	it("updates an existing completed tool_call instead of appending a duplicate", () => {
		let receive!: (event: MainToRendererEvent) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: MainToRendererEvent) => void) {
				receive = callback;
				return () => {};
			},
		});

		flushReceive(receive, uiEvent({ type: "run_status", status: "streaming", timestamp: 1 }));
		flushReceive(receive, uiEvent({ type: "toolcall_start", contentIndex: 0, timestamp: 2 }));
		flushReceive(
			receive,
			uiEvent({
				type: "toolcall_end",
				contentIndex: 0,
				toolCallId: "tc-1",
				toolName: "read",
				args: { path: "first.ts" },
				timestamp: 3,
			}),
		);

		flushReceive(
			receive,
			uiEvent({
				type: "toolcall_end",
				contentIndex: 0,
				toolCallId: "tc-1",
				toolName: "read",
				args: { path: "final.ts" },
				timestamp: 4,
			}),
		);

		const state = appStore.get(sessionStateAtomFamily(sessionId));
		const toolCalls = state.uiBlocks.filter((b) => b.contentIndex === 0 && b.kind === "toolcall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]).toMatchObject({
			toolCallId: "tc-1",
			toolName: "read",
			args: { path: "final.ts" },
			completed: true,
		});
	});

	it("tracks tool execution states in uiTools", () => {
		let receive!: (event: MainToRendererEvent) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: MainToRendererEvent) => void) {
				receive = callback;
				return () => {};
			},
		});

		// Tool execution events are emitted while the assistant phase is active.
		flushReceive(receive, uiEvent({ type: "run_status", status: "working", timestamp: 0 }));
		flushReceive(
			receive,
			uiEvent({
				type: "tool_exec_start",
				toolCallId: "te-1",
				toolName: "read",
				args: { path: "bar.ts" },
				timestamp: 1,
			}),
		);

		let state = appStore.get(sessionStateAtomFamily(sessionId));
		expect(state.uiTools["te-1"]).toBeDefined();
		expect(state.uiTools["te-1"].phase).toBe("running");

		flushReceive(
			receive,
			uiEvent({
				type: "tool_exec_end",
				toolCallId: "te-1",
				toolName: "read",
				result: "content",
				isError: false,
				timestamp: 2,
			}),
		);

		state = appStore.get(sessionStateAtomFamily(sessionId));
		expect(state.uiTools["te-1"].phase).toBe("completed");
		expect(state.uiTools["te-1"].result).toBe("content");
	});

	it("preserves completed blocks until the snapshot and resets them on a new run", () => {
		let receive!: (event: MainToRendererEvent) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: MainToRendererEvent) => void) {
				receive = callback;
				return () => {};
			},
		});

		flushReceive(receive, uiEvent({ type: "run_status", status: "streaming", timestamp: 1 }));
		flushReceive(receive, uiEvent({ type: "assistant_text_start", contentIndex: 0, timestamp: 2 }));
		flushReceive(receive, uiEvent({ type: "assistant_text_delta", contentIndex: 0, delta: "old", timestamp: 3 }));
		flushReceive(receive, uiEvent({ type: "run_status", status: "idle", timestamp: 4 }));

		// Preserve the completed live projection while the persisted snapshot is
		// still in flight, avoiding a one-frame blank assistant response.
		const afterFirst = appStore.get(sessionStateAtomFamily(sessionId));
		expect(afterFirst.uiBlocks.length).toBe(1);
		expect(afterFirst.uiBlocks[0]?.text).toBe("old");
		expect(afterFirst.uiPhase).toBe("idle");

		flushReceive(receive, uiEvent({ type: "run_status", status: "streaming", timestamp: 5 }));
		flushReceive(receive, uiEvent({ type: "assistant_text_start", contentIndex: 0, timestamp: 6 }));
		flushReceive(receive, uiEvent({ type: "assistant_text_delta", contentIndex: 0, delta: "new", timestamp: 7 }));

		const afterSecond = appStore.get(sessionStateAtomFamily(sessionId));
		expect(afterSecond.uiBlocks.length).toBe(1);
		const block = afterSecond.uiBlocks[0]!;
		expect(block.text).toBe("new");
	});

	it("tracks queue_updates", () => {
		let receive!: (event: MainToRendererEvent) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: MainToRendererEvent) => void) {
				receive = callback;
				return () => {};
			},
		});

		flushReceive(receive, uiEvent({ type: "queue_update", steering: ["s1"], followUp: ["f1"], timestamp: 1 }));
		const state = appStore.get(sessionStateAtomFamily(sessionId));
		expect(state.uiSteering).toEqual(["s1"]);
		expect(state.uiFollowUp).toEqual(["f1"]);
	});

	it("tracks compacting and retry phases", () => {
		let receive!: (event: MainToRendererEvent) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: MainToRendererEvent) => void) {
				receive = callback;
				return () => {};
			},
		});

		flushReceive(receive, uiEvent({ type: "compacting", active: true, timestamp: 1 }));
		expect(appStore.get(sessionStateAtomFamily(sessionId)).uiPhase).toBe("compacting");

		flushReceive(
			receive,
			uiEvent({
				type: "retry_status",
				status: "start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 1000,
				errorMessage: "err",
				timestamp: 2,
			}),
		);
		expect(appStore.get(sessionStateAtomFamily(sessionId)).uiPhase).toBe("retrying");

		flushReceive(receive, uiEvent({ type: "retry_status", status: "end", attempt: 1, success: true, timestamp: 3 }));
	});

	// ── Regression: stale queue display — message shown as queued while also sent ──
	// A snapshot taken while a steer/followUp message is genuinely pending carries
	// that message in runtime.steering. The snapshot must seed uiSteering so the
	// drawer keeps showing it; the delivery queue_update([]) is what actually
	// removes it — the runtime values must NOT resurrect it afterwards.
	it("seeds uiSteering from a snapshot that captured a pending queued message, then clears on delivery", () => {
		let receive!: (event: MainToRendererEvent) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: MainToRendererEvent) => void) {
				receive = callback;
				return () => {};
			},
		});

		// agent_end snapshot: the steer message is still genuinely queued (the
		// agent loop's final drain already ran, so it will be delivered by the
		// post-agent-run continuation).
		receive({
			type: "session:snapshot",
			sessionId,
			reason: "agent_end",
			sequence: 1,
			leafId: null,
			entries: [],
			runtime: {
				model: undefined,
				thinkingLevel: "off",
				isStreaming: false,
				isRetrying: false,
				isCompacting: false,
				retryAttempt: 0,
				steering: ["stale-message"],
				followUp: [],
				stats: { totalMessages: 1 },
			},
		});
		const seeded = appStore.get(sessionStateAtomFamily(sessionId));
		expect(seeded.uiSteering).toEqual(["stale-message"]);

		// Delivery: the continuation run emits message_start for the queued text,
		// the SDK removes it and emits queue_update with empty arrays.
		flushReceive(receive, uiEvent({ type: "queue_update", steering: [], followUp: [], timestamp: 2 }));
		const cleared = appStore.get(sessionStateAtomFamily(sessionId));
		expect(cleared.uiSteering).toEqual([]);
		// The drawer must not resurrect the stale runtime snapshot value.
		expect(deriveActiveQueue(cleared)).toEqual({ steering: [], followUp: [] });
	});

	it("keeps uiSteering after a mid-stream snapshot, and queue_update delivery clears it", () => {
		let receive!: (event: MainToRendererEvent) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: MainToRendererEvent) => void) {
				receive = callback;
				return () => {};
			},
		});

		// compaction_start emits an "activate" snapshot while a steer message is queued.
		receive({
			type: "session:snapshot",
			sessionId,
			reason: "activate",
			sequence: 1,
			leafId: null,
			entries: [],
			runtime: {
				model: undefined,
				thinkingLevel: "off",
				isStreaming: true,
				isRetrying: false,
				isCompacting: false,
				retryAttempt: 0,
				steering: ["queued-1"],
				followUp: [],
				stats: { totalMessages: 1 },
			},
		});
		expect(appStore.get(sessionStateAtomFamily(sessionId)).uiSteering).toEqual(["queued-1"]);

		// queue_update arrives first: another message was queued.
		flushReceive(
			receive,
			uiEvent({ type: "queue_update", steering: ["queued-1", "queued-2"], followUp: [], timestamp: 2 }),
		);
		expect(appStore.get(sessionStateAtomFamily(sessionId)).uiSteering).toEqual(["queued-1", "queued-2"]);

		// Delivery of both: queue_update([]) must fully clear the drawer.
		flushReceive(receive, uiEvent({ type: "queue_update", steering: [], followUp: [], timestamp: 3 }));
		const state = appStore.get(sessionStateAtomFamily(sessionId));
		expect(state.uiSteering).toEqual([]);
		expect(deriveActiveQueue(state)).toEqual({ steering: [], followUp: [] });
	});
});

describe("deriveSessionPhase", () => {
	it("maps uiPhase streaming to thinking, and working when tools are running", () => {
		expect(
			deriveSessionPhase({ uiPhase: "streaming", uiTools: {}, runtime: null } as unknown as Parameters<
				typeof deriveSessionPhase
			>[0]),
		).toBe("thinking");
		expect(
			deriveSessionPhase({
				uiPhase: "streaming",
				uiTools: { t1: { phase: "running" } as Record<string, { phase: string }> },
				runtime: null,
			} as unknown as Parameters<typeof deriveSessionPhase>[0]),
		).toBe("working");
	});

	it("maps uiPhase working/retrying/compacting directly", () => {
		expect(
			deriveSessionPhase({ uiPhase: "working", uiTools: {}, runtime: null } as unknown as Parameters<
				typeof deriveSessionPhase
			>[0]),
		).toBe("working");
		expect(
			deriveSessionPhase({ uiPhase: "retrying", uiTools: {}, runtime: null } as unknown as Parameters<
				typeof deriveSessionPhase
			>[0]),
		).toBe("retrying");
		expect(
			deriveSessionPhase({ uiPhase: "compacting", uiTools: {}, runtime: null } as unknown as Parameters<
				typeof deriveSessionPhase
			>[0]),
		).toBe("compacting");
	});

	it("falls back to runtime flags when uiPhase is idle", () => {
		expect(
			deriveSessionPhase({
				uiPhase: "idle",
				uiTools: {},
				runtime: { isStreaming: true } as Record<string, boolean>,
			} as unknown as Parameters<typeof deriveSessionPhase>[0]),
		).toBe("thinking");
		expect(
			deriveSessionPhase({
				uiPhase: "idle",
				uiTools: {},
				runtime: { isRetrying: true } as Record<string, boolean>,
			} as unknown as Parameters<typeof deriveSessionPhase>[0]),
		).toBe("retrying");
		expect(
			deriveSessionPhase({
				uiPhase: "idle",
				uiTools: {},
				runtime: { isCompacting: true } as Record<string, boolean>,
			} as unknown as Parameters<typeof deriveSessionPhase>[0]),
		).toBe("compacting");
	});

	it("returns idle by default", () => {
		expect(
			deriveSessionPhase({ uiPhase: "idle", uiTools: {}, runtime: null } as unknown as Parameters<
				typeof deriveSessionPhase
			>[0]),
		).toBe("idle");
		expect(deriveSessionPhase(null)).toBe("idle");
	});

	describe("deriveActiveQueue", () => {
		it("returns the event-path queue state", () => {
			expect(
				deriveActiveQueue({
					uiSteering: ["a"],
					uiFollowUp: ["b"],
					runtime: { steering: ["stale"], followUp: ["stale"] },
				} as unknown as Parameters<typeof deriveActiveQueue>[0]),
			).toEqual({ steering: ["a"], followUp: ["b"] });
		});

		it("regression: does NOT fall back to stale runtime.steering when the event path is empty", () => {
			// A message that was already delivered (and appears in the chat) must not
			// show as queued just because an older snapshot still carried it in
			// runtime.steering.
			expect(
				deriveActiveQueue({
					uiSteering: [],
					uiFollowUp: [],
					runtime: { steering: ["delivered-message"], followUp: [] },
				} as unknown as Parameters<typeof deriveActiveQueue>[0]),
			).toEqual({ steering: [], followUp: [] });
		});

		it("handles null/undefined state", () => {
			expect(deriveActiveQueue(null)).toEqual({ steering: [], followUp: [] });
			expect(deriveActiveQueue(undefined)).toEqual({ steering: [], followUp: [] });
		});
	});
});
