import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionEventBus } from "../src/main/session/events/session-event-bus.js";
import { SessionNotifier, type SessionNotifierQueries } from "../src/main/session/events/session-notifier.js";
import type { ManagedRuntime } from "../src/main/session/runtime/runtime-registry.js";
import type { SessionInfoService } from "../src/main/session/services/session-info-service.js";

afterEach(() => vi.useRealTimers());

function createQueries(runtime: ManagedRuntime | undefined): SessionNotifierQueries {
	const sessionInfoService = {
		getManagedRuntime: () => runtime,
		getAgentInfo: (sessionId: string) => ({
			id: sessionId,
			name: "Agent",
			model: "provider/model",
			thinkingLevel: "off",
			modelSupportsThinking: false,
			availableThinkingLevels: ["off"],
			isStreaming: false,
			isRetrying: false,
			isCompacting: false,
			messageCount: 1,
			createdAt: 1,
			projectId: "project-a",
		}),
		listAgentsInProject: () => [],
	} as unknown as SessionInfoService;
	return {
		sessionInfoService,
		scopeRegistry: { get: () => undefined },
		listProjects: () => [],
		getActiveProjectId: () => "project-a",
	};
}

describe("SessionNotifier", () => {
	it("throttles high-frequency context usage while preserving the latest eligible update", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(1_000));
		const bus = new SessionEventBus();
		const events: string[] = [];
		bus.onEvent((event) => events.push(event.type));
		const runtime = {
			runtime: { session: { getContextUsage: () => ({ tokens: 42 }) } },
		} as unknown as ManagedRuntime;
		const notifier = new SessionNotifier(bus, createQueries(runtime));

		notifier.emitContextUsage("session-a");
		notifier.emitContextUsage("session-a");
		vi.advanceTimersByTime(500);
		notifier.emitContextUsage("session-a");

		expect(events).toEqual(["agent:context-usage", "agent:context-usage"]);
	});

	it("projects agent updates through the event bus rather than directly to a renderer", () => {
		const bus = new SessionEventBus();
		const received: string[] = [];
		bus.onEvent((event) => {
			if (event.type === "agent:updated") received.push(event.agentId);
		});
		const notifier = new SessionNotifier(bus, createQueries(undefined));

		notifier.emitSessionUpdated("session-a");

		expect(received).toEqual(["session-a"]);
	});

	it("snapshot isStreaming mirrors the SDK live state even on agent_end", () => {
		// agent_end 快照必须如实反映 session.isStreaming：SDK 在 agent_end 之后
		// 仍可能处于收尾（compaction 判定/排队续跑），若此时强制 isStreaming=false，
		// 渲染端会短暂显示 idle，用户在这窗口发送的消息会被意外排队。
		// 真正的 idle 由 agent_settled 触发的终态快照通知。
		const bus = new SessionEventBus();
		const snapshots: Array<{ isStreaming: boolean }> = [];
		bus.onEvent((event) => {
			if (event.type === "session:snapshot") snapshots.push({ isStreaming: event.runtime.isStreaming });
		});
		const session = {
			sessionManager: {
				getBranch: () => [],
				getLeafId: () => null,
			},
			getSteeringMessages: () => [],
			getFollowUpMessages: () => [],
			getSessionStats: () => ({ totalMessages: 1 }),
			getContextUsage: () => undefined,
			isCompacting: false,
			isRetrying: false,
			isStreaming: true, // SDK 仍忙（agent_end 后收尾中）
			model: undefined,
			thinkingLevel: "off",
			retryAttempt: 0,
		} as unknown as ManagedRuntime["runtime"]["session"];
		const notifier = new SessionNotifier(bus, createQueries({ runtime: { session } } as unknown as ManagedRuntime));

		notifier.emitSessionState("session-a", "agent_end");

		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]!.isStreaming).toBe(true);
	});
});
