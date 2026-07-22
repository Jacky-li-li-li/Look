import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ManagedRuntime } from "../src/main/session/runtime-registry.js";
import { SessionScopeRegistry } from "../src/main/session/scope-registry.js";
import { SessionEventEffects } from "../src/main/session/session-event-effects.js";

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
		usageTrackingService: { recordMessageEnd: vi.fn(), dispose: vi.fn() },
		getStoredProjectId: vi.fn(),
		refreshProjectSessions: vi.fn().mockResolvedValue([]),
		emitSessionUpdated: vi.fn(),
		emitSessionList: vi.fn(),
		emitError: vi.fn(),
	};
	return { effects: new SessionEventEffects(options), options };
}

describe("SessionEventEffects", () => {
	it("tracks assistant completion and refreshes the session projection", async () => {
		const { effects, options } = makeEffects();
		const assistant = { role: "assistant", stopReason: "stop", content: [] } as unknown as AgentMessage;
		await effects.onMessageEnd("session-1", assistant);
		await effects.onAgentEnd("session-1");

		expect(options.subAgentRuntimeService.trackSubSessionMessageEnd).toHaveBeenCalledWith("session-1", assistant);
		expect(options.usageTrackingService.recordMessageEnd).toHaveBeenCalledWith(assistant);
		expect(options.permissionService.persistIfDirty).toHaveBeenCalledWith("session-1", expect.anything());
		expect(options.planService.persistToolSnapshotIfDirty).toHaveBeenCalledWith("session-1", expect.anything());
		expect(options.refreshProjectSessions).toHaveBeenCalledWith("project-1");
		expect(options.emitSessionUpdated).toHaveBeenCalledWith("session-1");
		expect(options.emitSessionList).toHaveBeenCalledWith("project-1");
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
});
