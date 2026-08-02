import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionEventEffects } from "../src/main/session/events/session-event-effects.js";
import type { ManagedRuntime } from "../src/main/session/runtime/runtime-registry.js";
import { SessionScopeRegistry } from "../src/main/session/scope/scope-registry.js";

// Hoist mock so it's set up before module imports execute
const markUsageDirty = vi.hoisted(() => vi.fn());
vi.mock("../src/main/system/usage-service.js", () => ({ markUsageDirty }));

function makeEffects() {
	const session = {
		sessionManager: { getSessionName: () => "New chat" },
	} as unknown as AgentSessionRuntime["session"];
	const managed: ManagedRuntime = {
		runtime: { session } as AgentSessionRuntime,
		projectId: "project-1",
		cwd: "/project",
		createdAt: 1,
		binding: { sessionId: "session-1", sessionManager: session.sessionManager },
		unsubscribe: vi.fn(),
	};
	const scopeRegistry = new SessionScopeRegistry();
	scopeRegistry.acquire("session-1", "project-1").isDefaultName = true;
	const options = {
		runtimeRegistry: { get: vi.fn(() => managed) },
		scopeRegistry,
		permissionService: { persistIfDirty: vi.fn() },
		planService: { persistToolSnapshotIfDirty: vi.fn() },
		subAgentRuntimeService: {
			trackSubSessionMessageEnd: vi.fn(),
			finalizeSubSession: vi.fn(),
		},
		subAgentRegistry: { hasPending: vi.fn().mockReturnValue(true) },
		autoTitleService: { generateForFirstUserMessage: vi.fn().mockResolvedValue(undefined) },
		emitUsageUpdated: vi.fn(),
		getStoredProjectId: vi.fn(),
		refreshProjectSessions: vi.fn().mockResolvedValue([]),
		emitSessionUpdated: vi.fn(),
		emitSessionList: vi.fn(),
		emitError: vi.fn(),
	};
	return { effects: new SessionEventEffects(options), options };
}

function makeMockMessage(overrides: Partial<AgentMessage>): AgentMessage {
	return { role: "assistant", stopReason: "stop", content: [], ...overrides } as unknown as AgentMessage;
}

describe("SessionEventEffects", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("marks usage dirty, emits updated, and refreshes project after assistant message", async () => {
		vi.useFakeTimers();
		const { effects, options } = makeEffects();
		const assistant = makeMockMessage({});
		await effects.onMessageEnd("session-1", assistant);
		vi.advanceTimersByTime(300);
		await effects.onAgentEnd("session-1");

		expect(options.subAgentRuntimeService.trackSubSessionMessageEnd).toHaveBeenCalledWith("session-1", assistant);
		expect(markUsageDirty).toHaveBeenCalledOnce();
		expect(options.emitUsageUpdated).toHaveBeenCalledOnce();
		expect(options.permissionService.persistIfDirty).toHaveBeenCalledWith("session-1", expect.anything());
		expect(options.planService.persistToolSnapshotIfDirty).toHaveBeenCalledWith("session-1", expect.anything());
		expect(options.refreshProjectSessions).toHaveBeenCalledWith("project-1");
		expect(options.emitSessionUpdated).toHaveBeenCalledWith("session-1");
		expect(options.emitSessionList).toHaveBeenCalledWith("project-1");
	});

	it("debounces usage emits across a burst of assistant messages", async () => {
		vi.useFakeTimers();
		const { effects, options } = makeEffects();
		await effects.onMessageEnd("session-1", makeMockMessage({}));
		await effects.onMessageEnd("session-1", makeMockMessage({ stopReason: "toolUse" }));
		await effects.onMessageEnd("session-1", makeMockMessage({}));

		expect(markUsageDirty).toHaveBeenCalledTimes(3);
		vi.advanceTimersByTime(299);
		expect(options.emitUsageUpdated).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(options.emitUsageUpdated).toHaveBeenCalledOnce();
		effects.dispose();
	});

	it("skips usage tracking for aborted assistant messages", async () => {
		vi.useFakeTimers();
		const { effects, options } = makeEffects();
		const aborted = makeMockMessage({ stopReason: "aborted" });
		await effects.onMessageEnd("session-1", aborted);
		vi.advanceTimersByTime(1000);

		expect(options.subAgentRuntimeService.trackSubSessionMessageEnd).toHaveBeenCalledWith("session-1", aborted);
		expect(markUsageDirty).not.toHaveBeenCalled();
		expect(options.emitUsageUpdated).not.toHaveBeenCalled();
	});

	it("cancels a pending usage emit on dispose", async () => {
		vi.useFakeTimers();
		const { effects, options } = makeEffects();
		await effects.onMessageEnd("session-1", makeMockMessage({}));
		effects.dispose();
		vi.advanceTimersByTime(1000);

		expect(options.emitUsageUpdated).not.toHaveBeenCalled();
	});

	it("ignores user messages for usage tracking", async () => {
		const { effects, options } = makeEffects();
		const user = { role: "user", content: "hello" } as AgentMessage;
		await effects.onMessageEnd("session-1", user);

		expect(markUsageDirty).not.toHaveBeenCalled();
		expect(options.emitUsageUpdated).not.toHaveBeenCalled();
	});

	it("delegates first-user-message titles and pending sub-session finalization", async () => {
		const { effects, options } = makeEffects();
		const user = { role: "user", content: "hello" } as AgentMessage;
		await effects.onMessageEnd("session-1", user);
		effects.onSubSessionAgentEnd("session-1");

		expect(options.autoTitleService.generateForFirstUserMessage).toHaveBeenCalledWith(
			expect.anything(),
			user,
			true,
			"session-1",
		);
		expect(options.subAgentRuntimeService.finalizeSubSession).toHaveBeenCalledWith("session-1");
	});

	it("willRetry=false: 持久化 turn duration（对齐 pi-coding-agent 规范）", async () => {
		const sessionManager = {
			getSessionName: () => "New chat",
			isPersisted: () => true,
			getBranch: () => [
				{
					type: "message",
					id: "entry-a1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
				},
			],
			appendCustomEntry: vi.fn(),
		};
		const session = { sessionManager } as unknown as AgentSessionRuntime["session"];
		const managed: ManagedRuntime = {
			runtime: { session } as AgentSessionRuntime,
			projectId: "project-1",
			cwd: "/project",
			createdAt: 1,
			binding: { sessionId: "session-1", sessionManager },
			unsubscribe: vi.fn(),
		};
		const { effects, options } = makeEffects();
		options.runtimeRegistry.get.mockReturnValue(managed);
		const scope = options.scopeRegistry.get("session-1");
		scope!.turnStartedAt = 1000;

		await effects.onAgentEnd("session-1", false);

		expect(sessionManager.appendCustomEntry).toHaveBeenCalledTimes(1);
		expect(scope!.turnStartedAt).toBeNull();
	});

	it("willRetry=true: 不持久化 duration，保留 turnStartedAt 供真正结束使用", async () => {
		const sessionManager = {
			getSessionName: () => "New chat",
			isPersisted: () => true,
			getBranch: () => [],
			appendCustomEntry: vi.fn(),
		};
		const session = { sessionManager } as unknown as AgentSessionRuntime["session"];
		const managed: ManagedRuntime = {
			runtime: { session } as AgentSessionRuntime,
			projectId: "project-1",
			cwd: "/project",
			createdAt: 1,
			binding: { sessionId: "session-1", sessionManager },
			unsubscribe: vi.fn(),
		};
		const { effects, options } = makeEffects();
		options.runtimeRegistry.get.mockReturnValue(managed);
		const scope = options.scopeRegistry.get("session-1");
		scope!.turnStartedAt = 1000;

		// 失败重试：agent_end(willRetry=true) 不应写时长、不应清空 turnStartedAt
		await effects.onAgentEnd("session-1", true);

		expect(sessionManager.appendCustomEntry).not.toHaveBeenCalled();
		expect(scope!.turnStartedAt).toBe(1000);
	});
});
