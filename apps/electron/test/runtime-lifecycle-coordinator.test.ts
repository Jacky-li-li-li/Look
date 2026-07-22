import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ActiveSessionSelection } from "../src/main/session/active-session-selection.js";
import {
	RuntimeLifecycleCoordinator,
	type RuntimeLifecycleCoordinatorOptions,
} from "../src/main/session/runtime-lifecycle-coordinator.js";
import { RuntimeRegistry } from "../src/main/session/runtime-registry.js";
import { SessionScopeRegistry } from "../src/main/session/scope-registry.js";
import type { StoredSession } from "../src/main/session/session-catalog.js";

interface SessionFixture {
	session: AgentSession;
	bindExtensions: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
	unsubscribe: ReturnType<typeof vi.fn>;
	emit(event: AgentSessionEvent): void;
}

interface RuntimeFixture {
	runtime: AgentSessionRuntime;
	dispose: ReturnType<typeof vi.fn>;
	rebind(next: SessionFixture): Promise<void>;
}

function makeSession(sessionId: string, isStreaming = false): SessionFixture {
	let subscriber: ((event: AgentSessionEvent) => void) | undefined;
	const unsubscribe = vi.fn();
	const bindExtensions = vi.fn().mockResolvedValue(undefined);
	const abort = vi.fn().mockResolvedValue(undefined);
	const session = {
		sessionId,
		sessionManager: { getSessionId: () => sessionId } as SessionManager,
		isStreaming,
		bindExtensions,
		abort,
		subscribe: vi.fn((callback: (event: AgentSessionEvent) => void) => {
			subscriber = callback;
			return unsubscribe;
		}),
	} as unknown as AgentSession;
	return {
		session,
		bindExtensions,
		abort,
		unsubscribe,
		emit: (event) => subscriber?.(event),
	};
}

function makeRuntime(
	initialSession: SessionFixture,
	diagnostics: AgentSessionRuntime["diagnostics"] = [],
): RuntimeFixture {
	let rebindHandler: ((session: AgentSession) => Promise<void>) | undefined;
	let beforeSessionInvalidate: (() => void) | undefined;
	const dispose = vi.fn(async () => {
		beforeSessionInvalidate?.();
	});
	const runtime = {
		session: initialSession.session,
		cwd: "/project",
		diagnostics,
		modelFallbackMessage: undefined,
		dispose,
		setBeforeSessionInvalidate: vi.fn((handler: () => void) => {
			beforeSessionInvalidate = handler;
		}),
		setRebindSession: vi.fn((handler: (session: AgentSession) => Promise<void>) => {
			rebindHandler = handler;
		}),
	} as unknown as AgentSessionRuntime;
	return {
		runtime,
		dispose,
		rebind: async (next) => {
			beforeSessionInvalidate?.();
			(runtime as { session: AgentSession }).session = next.session;
			if (!rebindHandler) throw new Error("rebind handler was not installed");
			await rebindHandler(next.session);
		},
	};
}

function storedSession(id: string): StoredSession {
	return {
		id,
		name: "Session",
		firstMessage: "",
		messageCount: 1,
		created: new Date(123),
		modified: new Date(123),
		path: `/sessions/${id}.jsonl`,
		cwd: "/project",
		projectId: "project-1",
		allMessagesText: "",
	};
}

function makeCoordinator(runtimeFixture: RuntimeFixture, stored = storedSession("session-1")) {
	const runtimeRegistry = new RuntimeRegistry();
	const scopeRegistry = new SessionScopeRegistry();
	const selection = new ActiveSessionSelection();
	const emitted: unknown[] = [];
	const dependencies = {
		runtimeFactory: { create: vi.fn().mockResolvedValue(runtimeFixture.runtime) },
		runtimeRegistry,
		scopeRegistry,
		permissionService: {
			restoreFromSession: vi.fn(),
			cancelPending: vi.fn(),
			persistIfDirty: vi.fn(),
			disposeSession: vi.fn(),
		},
		planService: {
			restoreToolSnapshot: vi.fn(),
			syncToolState: vi.fn(),
			cancelInteractions: vi.fn(),
			persistToolSnapshotIfDirty: vi.fn(),
			disposeSession: vi.fn(),
		},
		subAgentRegistry: {
			hasPending: vi.fn().mockReturnValue(false),
			abortPendingForParent: vi.fn(),
			unregister: vi.fn(),
		},
		subAgentRuntimeService: {
			finalizeSubSession: vi.fn(),
			cancelSubSessionCleanup: vi.fn(),
		},
		autoTitleService: { dispose: vi.fn() },
		eventProcessor: { dispose: vi.fn() },
		sessionSubagentService: { applyDefaultOnBind: vi.fn(), clearSession: vi.fn() },
		sessionNotifier: { disposeSession: vi.fn() },
		selection,
		getStoredSession: vi.fn((sessionId: string) => (sessionId === stored.id ? stored : undefined)),
		openSessionManager: vi.fn(() => ({ getSessionId: () => stored.id }) as SessionManager),
		handleSessionEvent: vi.fn(),
		setActiveProjectId: vi.fn(),
		refreshProjectSessions: vi.fn().mockResolvedValue([]),
		events: {
			emit: vi.fn((event) => emitted.push(event)),
			emitSessionState: vi.fn(),
			emitProjectList: vi.fn(),
		},
	} satisfies RuntimeLifecycleCoordinatorOptions;
	return {
		coordinator: new RuntimeLifecycleCoordinator(dependencies),
		dependencies,
		runtimeRegistry,
		scopeRegistry,
		selection,
		emitted,
	};
}

describe("RuntimeLifecycleCoordinator", () => {
	it("deduplicates ensureRuntime and binds all session-local state once", async () => {
		const session = makeSession("session-1");
		const runtime = makeRuntime(session);
		const fixture = makeCoordinator(runtime);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(fixture.dependencies.runtimeFactory.create).mockImplementation(async () => {
			await gate;
			return runtime.runtime;
		});

		const first = fixture.coordinator.ensureRuntime("session-1");
		const second = fixture.coordinator.ensureRuntime("session-1");
		release();

		expect(await first).toBe(await second);
		expect(fixture.dependencies.runtimeFactory.create).toHaveBeenCalledTimes(1);
		expect(session.bindExtensions).toHaveBeenCalledWith(expect.objectContaining({ mode: "rpc" }));
		expect(fixture.dependencies.permissionService.restoreFromSession).toHaveBeenCalledWith(
			"session-1",
			session.session.sessionManager,
		);
		expect(fixture.dependencies.planService.restoreToolSnapshot).toHaveBeenCalledWith(
			"session-1",
			session.session.sessionManager,
		);
		expect(fixture.scopeRegistry.has("session-1")).toBe(true);
		expect(fixture.runtimeRegistry.get("session-1")?.projectId).toBe("project-1");

		const event = { type: "agent_start" } as AgentSessionEvent;
		session.emit(event);
		expect(fixture.dependencies.handleSessionEvent).toHaveBeenCalledWith("session-1", event);
	});

	it("deduplicates concurrent calls at the shared runtime creation boundary", async () => {
		const session = makeSession("session-1");
		const runtime = makeRuntime(session);
		const fixture = makeCoordinator(runtime);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(fixture.dependencies.runtimeFactory.create).mockImplementation(async () => {
			await gate;
			return runtime.runtime;
		});

		const first = fixture.coordinator.createManagedRuntime("/project", session.session.sessionManager, "project-1");
		const second = fixture.coordinator.createManagedRuntime("/project", session.session.sessionManager, "project-1");
		release();

		expect(await first).toBe(await second);
		expect(fixture.dependencies.runtimeFactory.create).toHaveBeenCalledTimes(1);
		expect(session.bindExtensions).toHaveBeenCalledTimes(1);
	});

	it("disposes a runtime when extension binding fails", async () => {
		const session = makeSession("session-1");
		session.bindExtensions.mockRejectedValueOnce(new Error("extension bind failed"));
		const runtime = makeRuntime(session);
		const fixture = makeCoordinator(runtime);

		await expect(
			fixture.coordinator.createManagedRuntime("/project", session.session.sessionManager, "project-1"),
		).rejects.toThrow("extension bind failed");
		expect(runtime.dispose).toHaveBeenCalledTimes(1);
		expect(fixture.runtimeRegistry.has("session-1")).toBe(false);
		expect(fixture.dependencies.permissionService.disposeSession).toHaveBeenCalledWith("session-1");
		expect(fixture.dependencies.planService.disposeSession).toHaveBeenCalledWith("session-1");
	});

	it("moves registry, scope, persisted state, and active selection during rebind", async () => {
		const firstSession = makeSession("session-1");
		const nextSession = makeSession("session-2");
		const runtime = makeRuntime(firstSession);
		const fixture = makeCoordinator(runtime);
		await fixture.coordinator.createManagedRuntime("/project", firstSession.session.sessionManager, "project-1");
		fixture.selection.setCurrent("session-1");

		await runtime.rebind(nextSession);

		expect(firstSession.unsubscribe).toHaveBeenCalledTimes(1);
		expect(fixture.runtimeRegistry.has("session-1")).toBe(false);
		expect(fixture.runtimeRegistry.get("session-2")?.runtime).toBe(runtime.runtime);
		expect(fixture.scopeRegistry.has("session-1")).toBe(false);
		expect(fixture.scopeRegistry.has("session-2")).toBe(true);
		expect(nextSession.bindExtensions).toHaveBeenCalledTimes(1);
		expect(fixture.dependencies.permissionService.cancelPending).toHaveBeenCalledWith("session-1");
		expect(fixture.dependencies.permissionService.persistIfDirty).toHaveBeenCalledWith(
			"session-1",
			firstSession.session.sessionManager,
		);
		expect(fixture.dependencies.permissionService.persistIfDirty).not.toHaveBeenCalledWith(
			"session-1",
			nextSession.session.sessionManager,
		);
		expect(fixture.dependencies.planService.persistToolSnapshotIfDirty).toHaveBeenCalledWith(
			"session-1",
			firstSession.session.sessionManager,
		);
		expect(fixture.dependencies.permissionService.restoreFromSession).toHaveBeenLastCalledWith(
			"session-2",
			nextSession.session.sessionManager,
		);
		expect(fixture.dependencies.planService.syncToolState).toHaveBeenLastCalledWith("session-2");
		expect(fixture.selection.currentId).toBe("session-2");
	});

	it("rejects a rebind that would replace another live runtime", async () => {
		const firstSession = makeSession("session-1");
		const secondSession = makeSession("session-2");
		const firstRuntime = makeRuntime(firstSession);
		const secondRuntime = makeRuntime(secondSession);
		const fixture = makeCoordinator(firstRuntime);
		await fixture.coordinator.createManagedRuntime("/project", firstSession.session.sessionManager, "project-1");
		vi.mocked(fixture.dependencies.runtimeFactory.create).mockResolvedValueOnce(secondRuntime.runtime);
		await fixture.coordinator.createManagedRuntime("/project", secondSession.session.sessionManager, "project-1");

		await expect(firstRuntime.rebind(secondSession)).rejects.toThrow("already has a live runtime");
		expect(firstRuntime.dispose).toHaveBeenCalledTimes(1);
		expect(fixture.runtimeRegistry.has("session-1")).toBe(false);
		expect(fixture.runtimeRegistry.get("session-2")?.runtime).toBe(secondRuntime.runtime);
		expect(firstSession.unsubscribe).toHaveBeenCalledTimes(1);
		expect(fixture.dependencies.permissionService.disposeSession).not.toHaveBeenCalledWith("session-2");
	});

	it("discards a rebound runtime when extension binding fails", async () => {
		const firstSession = makeSession("session-1");
		const nextSession = makeSession("session-2");
		nextSession.bindExtensions.mockRejectedValueOnce(new Error("extension bind failed"));
		const runtime = makeRuntime(firstSession);
		const fixture = makeCoordinator(runtime);
		await fixture.coordinator.createManagedRuntime("/project", firstSession.session.sessionManager, "project-1");
		fixture.selection.setCurrent("session-1");

		await expect(runtime.rebind(nextSession)).rejects.toThrow("extension bind failed");

		expect(runtime.dispose).toHaveBeenCalledTimes(1);
		expect(fixture.runtimeRegistry.has("session-1")).toBe(false);
		expect(fixture.runtimeRegistry.has("session-2")).toBe(false);
		expect(fixture.scopeRegistry.has("session-1")).toBe(false);
		expect(fixture.scopeRegistry.has("session-2")).toBe(false);
		expect(fixture.selection.currentId).toBeNull();
	});

	it("discards a rebound runtime when session-local finalization fails", async () => {
		const firstSession = makeSession("session-1");
		const nextSession = makeSession("session-2");
		const runtime = makeRuntime(firstSession);
		const fixture = makeCoordinator(runtime);
		await fixture.coordinator.createManagedRuntime("/project", firstSession.session.sessionManager, "project-1");
		vi.mocked(fixture.dependencies.planService.syncToolState).mockImplementationOnce(() => {
			throw new Error("tool sync failed");
		});

		await expect(runtime.rebind(nextSession)).rejects.toThrow("tool sync failed");

		expect(runtime.dispose).toHaveBeenCalledTimes(1);
		expect(fixture.runtimeRegistry.has("session-1")).toBe(false);
		expect(fixture.runtimeRegistry.has("session-2")).toBe(false);
	});

	it("rejects and disposes a replacement that changes the runtime cwd", async () => {
		const firstSession = makeSession("session-1");
		const nextSession = makeSession("session-2");
		const runtime = makeRuntime(firstSession);
		const fixture = makeCoordinator(runtime);
		await fixture.coordinator.createManagedRuntime("/project", firstSession.session.sessionManager, "project-1");
		fixture.selection.setCurrent("session-1");
		(runtime.runtime as { cwd: string }).cwd = "/other-project";

		await expect(runtime.rebind(nextSession)).rejects.toThrow("Runtime cwd cannot change");

		expect(runtime.dispose).toHaveBeenCalledTimes(1);
		expect(fixture.runtimeRegistry.has("session-1")).toBe(false);
		expect(fixture.runtimeRegistry.has("session-2")).toBe(false);
		expect(fixture.selection.currentId).toBeNull();
	});

	it("deduplicates disposal and tears down every session-bound service", async () => {
		const session = makeSession("session-1", true);
		const runtime = makeRuntime(session);
		const fixture = makeCoordinator(runtime);
		await fixture.coordinator.createManagedRuntime("/project", session.session.sessionManager, "project-1");
		vi.mocked(fixture.dependencies.subAgentRegistry.hasPending).mockReturnValue(true);

		await Promise.all([
			fixture.coordinator.disposeRuntime("session-1", true),
			fixture.coordinator.disposeRuntime("session-1", true),
		]);

		expect(session.abort).toHaveBeenCalledTimes(1);
		expect(session.unsubscribe).toHaveBeenCalledTimes(1);
		expect(runtime.dispose).toHaveBeenCalledTimes(1);
		expect(fixture.dependencies.subAgentRuntimeService.finalizeSubSession).toHaveBeenCalledWith("session-1", true);
		expect(fixture.dependencies.permissionService.persistIfDirty).toHaveBeenCalledWith(
			"session-1",
			session.session.sessionManager,
		);
		expect(fixture.dependencies.planService.persistToolSnapshotIfDirty).toHaveBeenCalledWith(
			"session-1",
			session.session.sessionManager,
		);
		expect(fixture.dependencies.eventProcessor.dispose).toHaveBeenCalledWith("session-1");
		expect(fixture.runtimeRegistry.has("session-1")).toBe(false);
		expect(fixture.scopeRegistry.has("session-1")).toBe(false);
	});

	it("waits for disposal before recreating the same session runtime", async () => {
		const firstSession = makeSession("session-1");
		const firstRuntime = makeRuntime(firstSession);
		const fixture = makeCoordinator(firstRuntime);
		await fixture.coordinator.createManagedRuntime("/project", firstSession.session.sessionManager, "project-1");

		let releaseDispose!: () => void;
		const disposeGate = new Promise<void>((resolve) => {
			releaseDispose = resolve;
		});
		firstRuntime.dispose.mockImplementationOnce(() => disposeGate);
		const secondSession = makeSession("session-1");
		const secondRuntime = makeRuntime(secondSession);
		vi.mocked(fixture.dependencies.runtimeFactory.create).mockResolvedValueOnce(secondRuntime.runtime);

		const disposal = fixture.coordinator.disposeRuntime("session-1");
		await Promise.resolve();
		const recreated = fixture.coordinator.ensureRuntime("session-1");
		await Promise.resolve();
		expect(fixture.dependencies.runtimeFactory.create).toHaveBeenCalledTimes(1);

		releaseDispose();
		await disposal;
		expect((await recreated).runtime).toBe(secondRuntime.runtime);
		expect(fixture.dependencies.runtimeFactory.create).toHaveBeenCalledTimes(2);
	});

	it("waits for in-flight initialization before disposing all runtimes", async () => {
		const session = makeSession("session-1");
		const runtime = makeRuntime(session);
		const fixture = makeCoordinator(runtime);
		let releaseCreate!: () => void;
		const createGate = new Promise<void>((resolve) => {
			releaseCreate = resolve;
		});
		vi.mocked(fixture.dependencies.runtimeFactory.create).mockImplementation(async () => {
			await createGate;
			return runtime.runtime;
		});

		const creation = fixture.coordinator.createManagedRuntime(
			"/project",
			session.session.sessionManager,
			"project-1",
		);
		const disposal = fixture.coordinator.disposeAllRuntimes();
		releaseCreate();
		await Promise.all([creation, disposal]);

		expect(runtime.dispose).toHaveBeenCalledTimes(1);
		expect(fixture.runtimeRegistry.has("session-1")).toBe(false);
	});

	it("finishes teardown when abort fails and reports the disposal error", async () => {
		const session = makeSession("session-1", true);
		session.abort.mockRejectedValueOnce(new Error("abort failed"));
		const runtime = makeRuntime(session);
		const fixture = makeCoordinator(runtime);
		await fixture.coordinator.createManagedRuntime("/project", session.session.sessionManager, "project-1");

		await expect(fixture.coordinator.disposeRuntime("session-1", true)).rejects.toThrow(
			"Failed to fully dispose runtime session-1",
		);

		expect(runtime.dispose).toHaveBeenCalledTimes(1);
		expect(session.unsubscribe).toHaveBeenCalledTimes(1);
		expect(fixture.runtimeRegistry.has("session-1")).toBe(false);
		expect(fixture.scopeRegistry.has("session-1")).toBe(false);
	});

	it("activates a runtime once and emits a lightweight snapshot when reselected", async () => {
		const session = makeSession("session-1");
		const runtime = makeRuntime(session);
		const fixture = makeCoordinator(runtime);
		await fixture.coordinator.createManagedRuntime("/project", session.session.sessionManager, "project-1");

		await fixture.coordinator.activateSession("session-1");
		await fixture.coordinator.activateSession("session-1");

		expect(fixture.selection.currentId).toBe("session-1");
		expect(fixture.dependencies.setActiveProjectId).toHaveBeenCalledWith("project-1");
		expect(fixture.dependencies.refreshProjectSessions).toHaveBeenCalledTimes(1);
		expect(fixture.dependencies.events.emitProjectList).toHaveBeenCalledTimes(1);
		expect(fixture.emitted).toContainEqual({ type: "project:active-changed", projectId: "project-1" });
		expect(fixture.dependencies.events.emitSessionState).toHaveBeenLastCalledWith("session-1", "activate");
	});
});
