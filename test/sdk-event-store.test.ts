import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { agentsAtom, removeAgentAtoms, sessionStateAtomFamily } from "../src/renderer/store/atoms";
import { appStore, initIpcHandlers } from "../src/renderer/store/ipcHandler";

function assistant(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
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
	};
}

const runtime = {
	thinkingLevel: "off",
	isStreaming: true,
	isRetrying: false,
	isCompacting: false,
	retryAttempt: 0,
	steering: [],
	followUp: [],
	stats: { totalMessages: 0 },
};

let dispose: (() => void) | undefined;
const sessionIds = ["sdk-store-a", "sdk-store-b"];

afterEach(() => {
	dispose?.();
	dispose = undefined;
	for (const sessionId of sessionIds) removeAgentAtoms(sessionId);
	appStore.set(agentsAtom, []);
});

describe("SDK event canonical store", () => {
	it("resets streaming cursor fields on run boundaries", () => {
		let receive!: (event: any) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: any) => void) {
				receive = callback;
				return () => {};
			},
		});

		const first = assistant("first");
		const second = assistant("second");

		receive({ type: "session:sdk-event", sessionId: sessionIds[0], event: { type: "agent_start" } });
		receive({
			type: "session:sdk-event",
			sessionId: sessionIds[0],
			event: { type: "message_start", message: first },
		});

		const duringFirst = appStore.get(sessionStateAtomFamily(sessionIds[0]));
		expect(duringFirst.currentMessageRenderId).not.toBeNull();
		expect(duringFirst.turnStartedAt).toBeGreaterThan(0);

		receive({
			type: "session:sdk-event",
			sessionId: sessionIds[0],
			event: { type: "message_end", message: first },
		});
		receive({ type: "session:sdk-event", sessionId: sessionIds[0], event: { type: "agent_end", willRetry: false } });
		receive({
			type: "session:snapshot",
			sessionId: sessionIds[0],
			reason: "agent_end",
			leafId: "persisted",
			entries: [],
			runtime: { ...runtime, isStreaming: false },
		});

		const afterEnd = appStore.get(sessionStateAtomFamily(sessionIds[0]));
		expect(afterEnd.currentMessageRenderId).toBeNull();
		expect(afterEnd.turnStartedAt).toBe(0);
		expect(afterEnd.turnDurationMs).not.toBeNull();

		const beforeSecondStart = Date.now();
		receive({ type: "session:sdk-event", sessionId: sessionIds[0], event: { type: "agent_start" } });
		receive({
			type: "session:sdk-event",
			sessionId: sessionIds[0],
			event: { type: "message_start", message: second },
		});

		const duringSecond = appStore.get(sessionStateAtomFamily(sessionIds[0]));
		expect(duringSecond.currentMessageRenderId).not.toBeNull();
		expect(duringSecond.turnStartedAt).toBeGreaterThanOrEqual(beforeSecondStart);
		expect(duringSecond.turnDurationMs).toBeNull();
	});

	it("cleans up the ended run's live messages without dropping a retry run", () => {
		let receive!: (event: any) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: any) => void) {
				receive = callback;
				return () => {};
			},
		});

		const first = assistant("first");
		const retry = assistant("retry");

		// First run ends and requests a retry.
		receive({ type: "session:sdk-event", sessionId: sessionIds[0], event: { type: "agent_start" } });
		receive({
			type: "session:sdk-event",
			sessionId: sessionIds[0],
			event: { type: "message_start", message: first },
		});
		receive({
			type: "session:sdk-event",
			sessionId: sessionIds[0],
			event: { type: "message_end", message: first },
		});
		receive({ type: "session:sdk-event", sessionId: sessionIds[0], event: { type: "agent_end", willRetry: true } });

		const afterFirstEnd = appStore.get(sessionStateAtomFamily(sessionIds[0]));
		expect(afterFirstEnd.lastEndedRunId).toBe(1);

		// Retry starts before the agent_end snapshot arrives.
		receive({ type: "session:sdk-event", sessionId: sessionIds[0], event: { type: "agent_start" } });
		receive({
			type: "session:sdk-event",
			sessionId: sessionIds[0],
			event: { type: "message_start", message: retry },
		});

		const duringRetry = appStore.get(sessionStateAtomFamily(sessionIds[0]));
		expect(duringRetry.currentRunId).toBe(2);
		expect(duringRetry.liveMessages).toHaveLength(2);

		// Snapshot for the first run finally arrives.
		receive({
			type: "session:snapshot",
			sessionId: sessionIds[0],
			reason: "agent_end",
			leafId: "persisted",
			entries: [],
			runtime: { ...runtime, isStreaming: true },
		});

		const afterSnapshot = appStore.get(sessionStateAtomFamily(sessionIds[0]));
		expect(afterSnapshot.liveMessages).toHaveLength(1);
		expect(afterSnapshot.liveMessages[0]?.runId).toBe(2);
		expect(afterSnapshot.liveMessages[0]?.message).toBe(retry);
	});

	it("keeps persisted, live, and cumulative tool execution state separate and session-scoped", () => {
		let receive!: (event: any) => void;
		dispose = initIpcHandlers({
			onEvent(callback: (event: any) => void) {
				receive = callback;
				return () => {};
			},
		});
		const first = assistant("first");
		const partial = assistant("partial");
		const final = assistant("final");

		receive({ type: "session:sdk-event", sessionId: sessionIds[0], event: { type: "agent_start" } });
		receive({
			type: "session:sdk-event",
			sessionId: sessionIds[0],
			event: { type: "message_start", message: first },
		});
		receive({
			type: "session:sdk-event",
			sessionId: sessionIds[0],
			event: { type: "message_update", message: partial, assistantMessageEvent: { type: "text_delta", delta: "x" } },
		});
		receive({
			type: "session:sdk-event",
			sessionId: sessionIds[0],
			event: { type: "tool_execution_start", toolCallId: "call", toolName: "read", args: { path: "a" } },
		});
		receive({
			type: "session:sdk-event",
			sessionId: sessionIds[0],
			event: {
				type: "tool_execution_update",
				toolCallId: "call",
				toolName: "read",
				args: { path: "a" },
				partialResult: { content: [{ type: "text", text: "second cumulative value" }] },
			},
		});

		const beforeSnapshot = appStore.get(sessionStateAtomFamily(sessionIds[0]));
		expect(beforeSnapshot.liveMessages[0]?.message).toBe(partial);
		expect(beforeSnapshot.toolExecutions.call?.partialResult).toEqual({
			content: [{ type: "text", text: "second cumulative value" }],
		});
		expect(appStore.get(sessionStateAtomFamily(sessionIds[1])).liveMessages).toEqual([]);

		const entries = [{ type: "message", id: "persisted", parentId: null, timestamp: "now", message: first }];
		receive({
			type: "session:snapshot",
			sessionId: sessionIds[0],
			reason: "activate",
			leafId: "persisted",
			entries,
			runtime,
		});
		const activated = appStore.get(sessionStateAtomFamily(sessionIds[0]));
		expect(activated.entries).toBe(entries);
		expect(activated.liveMessages).toHaveLength(1);

		receive({
			type: "session:sdk-event",
			sessionId: sessionIds[0],
			event: { type: "message_end", message: final },
		});
		receive({
			type: "session:snapshot",
			sessionId: sessionIds[0],
			reason: "agent_end",
			leafId: "persisted",
			entries,
			runtime: { ...runtime, isStreaming: false },
		});
		const completed = appStore.get(sessionStateAtomFamily(sessionIds[0]));
		expect(completed.liveMessages).toEqual([]);
		expect(completed.toolExecutions).toEqual({});
	});
});
