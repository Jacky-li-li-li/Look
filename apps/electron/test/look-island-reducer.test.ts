import type { MainToRendererEvent } from "@look/shared/types";
import { describe, expect, it } from "vitest";
import {
	applyLookIslandEvent,
	buildLookIslandDisplayState,
	buildLookIslandPillSnapshot,
	collapseLookIsland,
	createLookIslandState,
	pruneLookIslandSessions,
	requestLookIslandExpand,
	setLookIslandAppFocused,
	showLookIslandIdleFeedback,
} from "../src/main/look-island/reducer.js";

function snapshotEvent(
	sessionId: string,
	streaming: boolean,
	reason: "initial" | "agent_end" = "initial",
): MainToRendererEvent {
	return {
		type: "session:snapshot",
		sessionId,
		reason,
		sequence: 1,
		leafId: null,
		entries: [],
		runtime: {
			model: undefined,
			thinkingLevel: "off",
			isStreaming: streaming,
			isRetrying: false,
			isCompacting: false,
			retryAttempt: 0,
			steering: [],
			followUp: [],
			stats: { messageCount: 0, toolCallCount: 0, totalTokens: 0 },
		},
	};
}

function permissionAskEvent(sessionId: string): MainToRendererEvent {
	return {
		type: "permission:ask",
		agentId: sessionId,
		event: {
			toolName: "bash",
			toolInput: { command: "npx build" },
			toolDescription: "Run `npx build`",
			requestId: "req-1",
			expiresAt: Date.now() + 60_000,
		},
	};
}

describe("LookIslandReducer", () => {
	it("marks a session running when a streaming snapshot arrives", () => {
		const state = createLookIslandState();
		const changed = applyLookIslandEvent(state, snapshotEvent("s1", true), 1000);
		expect(changed).toBe(true);
		const session = state.sessions.get("s1");
		expect(session?.phase).toBe("running");
	});

	it("marks a session completed on agent_end", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(state, snapshotEvent("s1", true), 1000);
		applyLookIslandEvent(state, snapshotEvent("s1", false, "agent_end"), 2000);
		expect(state.sessions.get("s1")?.phase).toBe("completed");
		expect(state.sessions.get("s1")?.attention).toBe(true);
	});

	it("promotes a session to needs-interaction on permission:ask", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(state, snapshotEvent("s1", true), 1000);
		applyLookIslandEvent(state, permissionAskEvent("s1"), 2000);
		const session = state.sessions.get("s1");
		expect(session?.phase).toBe("needs-interaction");
		expect(session?.interactionKind).toBe("permission");
		expect(session?.permissionToolName).toBe("bash");
	});

	it("raises a blocking interaction card on permission:ask", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(state, permissionAskEvent("s1"), 1000);
		const display = buildLookIslandDisplayState(state, { appFocused: true }, 1000);
		expect(display.visible).toBe(true);
		expect(display.mode).toBe("expanded");
		expect(display.displayPolicy).toBe("blocking");
		expect(display.notchStatus).toBe("expanded");
		expect(display.interaction).toMatchObject({
			kind: "permission",
			requestId: "req-1",
			toolName: "bash",
		});
	});

	it("clears the blocking permission card after permission:resolved", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(state, permissionAskEvent("s1"), 1000);
		applyLookIslandEvent(state, { type: "permission:resolved", agentId: "s1", requestId: "req-1" }, 2000);
		const display = buildLookIslandDisplayState(state, { appFocused: true }, 2000);
		expect(display.interaction).toBeNull();
		expect(display.visible).toBe(false);
		expect(display.displayPolicy).toBe("closed");
	});

	it("raises a blocking plan card on plan approval request", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(
			state,
			{
				type: "plan:approval-requested",
				agentId: "s1",
				request: {
					requestId: "plan-1",
					planId: "p1",
					sessionId: "s1",
					plan: "Step 1...",
					filePath: "/tmp/plan.md",
					title: "Refactor island module",
				},
			},
			1000,
		);
		const display = buildLookIslandDisplayState(state, { appFocused: true }, 1000);
		expect(display.displayPolicy).toBe("blocking");
		expect(display.interaction).toMatchObject({
			kind: "plan",
			requestId: "plan-1",
			title: "Refactor island module",
		});
	});

	it("returns to running after permission:resolved", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(state, permissionAskEvent("s1"), 1000);
		applyLookIslandEvent(state, { type: "permission:resolved", agentId: "s1", requestId: "req-1" }, 2000);
		const session = state.sessions.get("s1");
		expect(session?.phase).toBe("running");
		expect(session?.interactionKind).toBeUndefined();
		expect(session?.permissionToolName).toBeNull();
	});

	it("handles plan approval requests as needs-interaction", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(
			state,
			{
				type: "plan:approval-requested",
				agentId: "s1",
				request: {
					requestId: "plan-1",
					sessionId: "s1",
					title: "Refactor island module",
					plan: "Step 1...",
				},
			},
			1000,
		);
		const session = state.sessions.get("s1");
		expect(session?.phase).toBe("needs-interaction");
		expect(session?.interactionKind).toBe("plan_review");
	});

	it("marks error sessions", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(state, { type: "error", agentId: "s1", message: "LLM request failed" }, 1000);
		expect(state.sessions.get("s1")?.phase).toBe("error");
	});

	it("aggregates a pill snapshot across sessions", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(state, snapshotEvent("s1", true), 1000);
		applyLookIslandEvent(state, snapshotEvent("s2", true), 1000);
		applyLookIslandEvent(state, permissionAskEvent("s2"), 2000);
		applyLookIslandEvent(state, snapshotEvent("s3", false, "agent_end"), 2000);

		const pill = buildLookIslandPillSnapshot(state.sessions.values());
		expect(pill.sessionCount).toBe(3);
		expect(pill.activeSessionCount).toBe(2);
		expect(pill.pendingInteractionCount).toBe(1);
		expect(pill.unreadCompletedCount).toBe(1);
		expect(pill.phase).toBe("needs-interaction");
	});

	it("builds a hidden display state when the app is focused", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(state, snapshotEvent("s1", true), 1000);
		setLookIslandAppFocused(state, true);
		const display = buildLookIslandDisplayState(state, { appFocused: true }, 1000);
		expect(display.visible).toBe(false);
		expect(display.displayPolicy).toBe("closed");
	});

	it("builds a visible peek state when the app is not focused", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(state, snapshotEvent("s1", true), 1000);
		setLookIslandAppFocused(state, false);
		const display = buildLookIslandDisplayState(state, { appFocused: false }, 1000);
		expect(display.visible).toBe(true);
		expect(display.mode).toBe("compact");
		expect(display.notchStatus).toBe("peek");
		expect(display.currentSessionId).toBe("s1");
		expect(display.sessions).toHaveLength(1);
	});

	it("keeps the island visible even when focused once manually expanded", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(state, snapshotEvent("s1", true), 1000);
		setLookIslandAppFocused(state, true);
		requestLookIslandExpand(state);
		const display = buildLookIslandDisplayState(state, { appFocused: true }, 1000);
		expect(display.visible).toBe(true);
		expect(display.mode).toBe("expanded");
		expect(display.notchStatus).toBe("expanded");
		expect(display.displayPolicy).toBe("manualExpanded");
	});

	it("collapses back to compact pill on outside click", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(state, snapshotEvent("s1", true), 1000);
		setLookIslandAppFocused(state, true);
		requestLookIslandExpand(state);
		collapseLookIsland(state);
		const display = buildLookIslandDisplayState(state, { appFocused: true }, 1000);
		expect(display.visible).toBe(false);
		expect(display.mode).toBe("compact");
		expect(display.notchStatus).toBe("closed");
		expect(display.displayPolicy).toBe("closed");
	});

	it("requestLookIslandExpand is idempotent while expanded", () => {
		const state = createLookIslandState();
		expect(requestLookIslandExpand(state)).toBe(true);
		expect(requestLookIslandExpand(state)).toBe(false);
		expect(collapseLookIsland(state)).toBe(true);
		expect(collapseLookIsland(state)).toBe(false);
	});

	it("tracks sub-agent progress on the parent session", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(
			state,
			{
				type: "session:subagent-progress",
				parentSessionId: "s1",
				childSessionId: "s1-1",
				agentName: "Worker",
				toolCallId: "tool-1",
				taskTitle: "Implement island UI",
				task: "...",
				status: "running",
				partialOutput: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				model: "DeepSeek",
			},
			1000,
		);
		const display = buildLookIslandDisplayState(state, { appFocused: false }, 1000);
		expect(display.sessions[0].subagents).toHaveLength(1);
		expect(display.sessions[0].subagents?.[0]).toMatchObject({
			agentName: "Worker",
			taskTitle: "Implement island UI",
			status: "running",
			model: "DeepSeek",
		});
	});

	it("updates sub-agent status on completion", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(
			state,
			{
				type: "session:subagent-progress",
				parentSessionId: "s1",
				childSessionId: "s1-1",
				agentName: "Worker",
				toolCallId: "tool-1",
				taskTitle: "Implement island UI",
				task: "...",
				status: "running",
				partialOutput: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			},
			1000,
		);
		applyLookIslandEvent(
			state,
			{
				type: "session:subagent-completed",
				parentSessionId: "s1",
				childSessionId: "s1-1",
				agentName: "Worker",
				toolCallId: "tool-1",
				taskTitle: "Implement island UI",
				result: {
					sessionId: "s1-1",
					agentName: "Worker",
					status: "completed",
					finalOutput: "done",
				},
			},
			2000,
		);
		const display = buildLookIslandDisplayState(state, { appFocused: false }, 2000);
		expect(display.sessions[0].subagents?.[0]?.status).toBe("completed");
	});

	it("captures the model label and usage percent from a snapshot", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(
			state,
			{
				type: "session:snapshot",
				sessionId: "s1",
				reason: "initial",
				sequence: 1,
				leafId: null,
				entries: [],
				runtime: {
					model: {
						id: "deepseek-chat",
						name: "DeepSeek V3",
						api: "openai",
						provider: "deepseek",
						baseUrl: "",
					} as never,
					thinkingLevel: "off",
					isStreaming: true,
					isRetrying: false,
					isCompacting: false,
					retryAttempt: 0,
					steering: [],
					followUp: [],
					stats: { messageCount: 0, toolCallCount: 0, totalTokens: 0 },
					contextUsage: { tokens: 8000, contextWindow: 10000, percent: 80 },
				},
			},
			1000,
		);
		const display = buildLookIslandDisplayState(state, { appFocused: false }, 1000);
		expect(display.sessions[0].modelLabel).toBe("DeepSeek V3");
		expect(display.sessions[0].usagePercent).toBe(80);
		expect(display.pillSnapshot.usageWarning).toBe(false);
	});

	it("raises a usage warning when a session approaches the context limit", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(
			state,
			{
				type: "agent:context-usage",
				agentId: "s1",
				contextUsage: { tokens: 9500, contextWindow: 10000, percent: 95 },
			},
			1000,
		);
		const display = buildLookIslandDisplayState(state, { appFocused: false }, 1000);
		expect(display.pillSnapshot.usageWarning).toBe(true);
		expect(display.sessions[0].usagePercent).toBe(95);
	});

	it("shows an idle pill briefly after enable even without sessions", () => {
		const state = createLookIslandState();
		showLookIslandIdleFeedback(state, 6000);
		const display = buildLookIslandDisplayState(state, { appFocused: true }, 5000);
		expect(display.visible).toBe(true);
		expect(display.mode).toBe("compact");
		expect(display.sessions).toHaveLength(0);
	});

	it("hides again once the idle feedback window expires", () => {
		const state = createLookIslandState();
		showLookIslandIdleFeedback(state, 5000);
		const display = buildLookIslandDisplayState(state, { appFocused: true }, 7000);
		expect(display.visible).toBe(false);
	});

	it("clears the blocking permission card when its agent is destroyed", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(state, permissionAskEvent("s1"), 1000);
		expect(state.blockingInteraction).not.toBeNull();
		applyLookIslandEvent(state, { type: "agent:destroyed", agentId: "s1" }, 2000);
		expect(state.blockingInteraction).toBeNull();
	});

	it("keeps the blocking card for a different agent on destroy", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(state, permissionAskEvent("s1"), 1000);
		applyLookIslandEvent(state, { type: "agent:destroyed", agentId: "other" }, 2000);
		expect(state.blockingInteraction?.kind).toBe("permission");
	});

	it("marks sessions destroyed and clears their sub-agents", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(
			state,
			{
				type: "session:subagent-progress",
				parentSessionId: "s1",
				childSessionId: "s1-1",
				agentName: "Worker",
				toolCallId: "tool-1",
				taskTitle: "Implement island UI",
				task: "...",
				status: "running",
				partialOutput: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			},
			1000,
		);
		applyLookIslandEvent(state, { type: "agent:destroyed", agentId: "s1" }, 2000);
		const display = buildLookIslandDisplayState(state, { appFocused: false }, 2000);
		expect(display.sessions[0].phase).toBe("completed");
		expect(display.sessions[0].subagents ?? []).toHaveLength(0);
	});

	it("prunes destroyed sessions after the TTL", () => {
		const state = createLookIslandState();
		applyLookIslandEvent(state, snapshotEvent("s1", true), 1000);
		applyLookIslandEvent(state, { type: "agent:destroyed", agentId: "s1" }, 2000);
		// TTL is 5 minutes; prune at +6 minutes should evict it.
		const changed = pruneLookIslandSessions(state, 2000 + 6 * 60_000);
		expect(changed).toBe(true);
		expect(state.sessions.has("s1")).toBe(false);
	});

	it("caps the session map to avoid payload growth", () => {
		const state = createLookIslandState();
		// Create more than the 20-session cap.
		for (let index = 0; index < 25; index += 1) {
			applyLookIslandEvent(state, snapshotEvent(`s${index}`, true), 1000 + index);
		}
		pruneLookIslandSessions(state, 10_000);
		expect(state.sessions.size).toBeLessThanOrEqual(20);
	});
});
