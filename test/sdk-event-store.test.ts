import { afterEach, describe, expect, it } from "vitest";
import { agentsAtom, removeAgentAtoms, sessionStateAtomFamily } from "../src/renderer/store/atoms";
import { appStore, initIpcHandlers } from "../src/renderer/store/ipcHandler";
import { deriveSessionPhase } from "../src/renderer/store/sessionTypes";
import type { LookUiEvent } from "../src/main/shared/types";

const sessionId = "ui-store-a";

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

describe("UI event canonical store (session:ui-event)", () => {
	it("tracks run_status transitions in uiPhase", () => {
		let receive!: (event: any) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: any) => void) {
				receive = callback;
				return () => {};
			},
		});

		receive(uiEvent({ type: "run_status", status: "streaming", timestamp: 1 }));
		const during = appStore.get(sessionStateAtomFamily(sessionId));
		expect(during.uiPhase).toBe("streaming");
		expect(during.uiBlocks).toEqual([]);

		receive(uiEvent({ type: "run_status", status: "idle", timestamp: 2 }));
		const after = appStore.get(sessionStateAtomFamily(sessionId));
		expect(after.uiPhase).toBe("idle");
	});

	it("accumulates text deltas into uiBlocks", () => {
		let receive!: (event: any) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: any) => void) {
				receive = callback;
				return () => {};
			},
		});

		receive(uiEvent({ type: "run_status", status: "streaming", timestamp: 1 }));
		receive(uiEvent({ type: "assistant_text_start", contentIndex: 0, timestamp: 2 }));
		receive(uiEvent({ type: "assistant_text_delta", contentIndex: 0, delta: "Hello", timestamp: 3 }));
		receive(uiEvent({ type: "assistant_text_delta", contentIndex: 0, delta: " World", timestamp: 4 }));
		receive(uiEvent({ type: "assistant_text_end", contentIndex: 0, text: "Hello World", timestamp: 5 }));

		const state = appStore.get(sessionStateAtomFamily(sessionId));
		const block = state.uiBlocks.find((b) => b.contentIndex === 0 && b.kind === "text");
		expect(block).toBeDefined();
		expect(block!.text).toBe("Hello World");
		expect(block!.completed).toBe(true);
	});

	it("accumulates thinking deltas and marks completed", () => {
		let receive!: (event: any) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: any) => void) {
				receive = callback;
				return () => {};
			},
		});

		receive(uiEvent({ type: "run_status", status: "streaming", timestamp: 1 }));
		receive(uiEvent({ type: "thinking_start", contentIndex: 0, timestamp: 2 }));
		receive(uiEvent({ type: "thinking_delta", contentIndex: 0, delta: "Let me think...", timestamp: 3 }));

		const mid = appStore.get(sessionStateAtomFamily(sessionId));
		const midBlock = mid.uiBlocks.find((b) => b.contentIndex === 0 && b.kind === "thinking");
		expect(midBlock).toBeDefined();
		expect(midBlock!.thinking).toBe("Let me think...");
		expect(midBlock!.completed).toBe(false);

		receive(uiEvent({ type: "thinking_end", contentIndex: 0, thinking: "Let me think...", timestamp: 4 }));
		const end = appStore.get(sessionStateAtomFamily(sessionId));
		const endBlock = end.uiBlocks.find((b) => b.contentIndex === 0 && b.kind === "thinking");
		expect(endBlock!.completed).toBe(true);
	});

	it("tracks tool_call lifecycle in uiBlocks", () => {
		let receive!: (event: any) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: any) => void) {
				receive = callback;
				return () => {};
			},
		});

		receive(uiEvent({ type: "run_status", status: "streaming", timestamp: 1 }));
		receive(uiEvent({ type: "toolcall_start", contentIndex: 0, timestamp: 2 }));
		receive(
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

	it("tracks tool execution states in uiTools", () => {
		let receive!: (event: any) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: any) => void) {
				receive = callback;
				return () => {};
			},
		});

		// Tool execution events are emitted while the assistant phase is active.
		receive(uiEvent({ type: "run_status", status: "working", timestamp: 0 }));
		receive(
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

		receive(
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

	it("resets blocks and tools on new run", () => {
		let receive!: (event: any) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: any) => void) {
				receive = callback;
				return () => {};
			},
		});

		receive(uiEvent({ type: "run_status", status: "streaming", timestamp: 1 }));
		receive(uiEvent({ type: "assistant_text_start", contentIndex: 0, timestamp: 2 }));
		receive(uiEvent({ type: "assistant_text_delta", contentIndex: 0, delta: "old", timestamp: 3 }));
		receive(uiEvent({ type: "run_status", status: "idle", timestamp: 4 }));

		// Completed turns are cleared from transient UI state; the persisted
		// message will arrive with the next snapshot.
		const afterFirst = appStore.get(sessionStateAtomFamily(sessionId));
		expect(afterFirst.uiBlocks.length).toBe(0);
		expect(afterFirst.uiPhase).toBe("idle");

		receive(uiEvent({ type: "run_status", status: "streaming", timestamp: 5 }));
		receive(uiEvent({ type: "assistant_text_start", contentIndex: 0, timestamp: 6 }));
		receive(uiEvent({ type: "assistant_text_delta", contentIndex: 0, delta: "new", timestamp: 7 }));

		const afterSecond = appStore.get(sessionStateAtomFamily(sessionId));
		expect(afterSecond.uiBlocks.length).toBe(1);
		const block = afterSecond.uiBlocks[0]!;
		expect(block.text).toBe("new");
	});

	it("tracks queue_updates", () => {
		let receive!: (event: any) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: any) => void) {
				receive = callback;
				return () => {};
			},
		});

		receive(uiEvent({ type: "queue_update", steering: ["s1"], followUp: ["f1"], timestamp: 1 }));
		const state = appStore.get(sessionStateAtomFamily(sessionId));
		expect(state.uiSteering).toEqual(["s1"]);
		expect(state.uiFollowUp).toEqual(["f1"]);
	});

	it("tracks compacting and retry phases", () => {
		let receive!: (event: any) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: any) => void) {
				receive = callback;
				return () => {};
			},
		});

		receive(uiEvent({ type: "compacting", active: true, timestamp: 1 }));
		expect(appStore.get(sessionStateAtomFamily(sessionId)).uiPhase).toBe("compacting");

		receive(
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

		receive(uiEvent({ type: "retry_status", status: "end", attempt: 1, success: true, timestamp: 3 }));
	});
});

describe("deriveSessionPhase", () => {
	it("maps uiPhase streaming to thinking, and working when tools are running", () => {
		expect(deriveSessionPhase({ uiPhase: "streaming", uiTools: {}, runtime: null } as any)).toBe("thinking");
		expect(
			deriveSessionPhase({
				uiPhase: "streaming",
				uiTools: { t1: { phase: "running" } as any },
				runtime: null,
			} as any),
		).toBe("working");
	});

	it("maps uiPhase working/retrying/compacting directly", () => {
		expect(deriveSessionPhase({ uiPhase: "working", uiTools: {}, runtime: null } as any)).toBe("working");
		expect(deriveSessionPhase({ uiPhase: "retrying", uiTools: {}, runtime: null } as any)).toBe("retrying");
		expect(deriveSessionPhase({ uiPhase: "compacting", uiTools: {}, runtime: null } as any)).toBe("compacting");
	});

	it("falls back to runtime flags when uiPhase is idle", () => {
		expect(
			deriveSessionPhase({
				uiPhase: "idle",
				uiTools: {},
				runtime: { isStreaming: true } as any,
			} as any),
		).toBe("thinking");
		expect(
			deriveSessionPhase({
				uiPhase: "idle",
				uiTools: {},
				runtime: { isRetrying: true } as any,
			} as any),
		).toBe("retrying");
		expect(
			deriveSessionPhase({
				uiPhase: "idle",
				uiTools: {},
				runtime: { isCompacting: true } as any,
			} as any),
		).toBe("compacting");
	});

	it("returns idle by default", () => {
		expect(deriveSessionPhase({ uiPhase: "idle", uiTools: {}, runtime: null } as any)).toBe("idle");
		expect(deriveSessionPhase(null)).toBe("idle");
	});
});
