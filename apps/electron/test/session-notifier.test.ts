import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedRuntime } from "../src/main/session/runtime/runtime-registry.js";
import { SessionEventBus } from "../src/main/session/events/session-event-bus.js";
import type { SessionInfoService } from "../src/main/session/services/session-info-service.js";
import { SessionNotifier, type SessionNotifierQueries } from "../src/main/session/events/session-notifier.js";

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
});
