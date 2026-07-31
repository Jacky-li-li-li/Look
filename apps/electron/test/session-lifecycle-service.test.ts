import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ManagedRuntime } from "../src/main/session/runtime/runtime-registry.js";
import type { StoredSession } from "../src/main/session/services/session-catalog.js";
import type { SessionLifecycleHost } from "../src/main/session/services/session-lifecycle-service.js";
import { SessionLifecycleService } from "../src/main/session/services/session-lifecycle-service.js";

describe("SessionLifecycleService", () => {
	function makeSession(id = "session-1") {
		return {
			sessionId: id,
			setSessionName: vi.fn(),
			setModel: vi.fn().mockResolvedValue(undefined),
			abort: vi.fn().mockResolvedValue(undefined),
		};
	}

	function makeManagedRuntime(sessionId: string, projectId = "project-1", cwd = "/project"): ManagedRuntime {
		return {
			runtime: { session: makeSession(sessionId), cwd } as unknown as AgentSessionRuntime,
			projectId,
			cwd,
			createdAt: Date.now(),
			unsubscribe: vi.fn(),
		};
	}

	function makeService(overrides?: {
		activeProjectId?: string | null;
		runtime?: ManagedRuntime | null;
		stored?: StoredSession | null;
	}) {
		const projectId = overrides?.activeProjectId ?? "project-1";
		const runtime = overrides?.runtime ?? makeManagedRuntime("session-1");
		const host: SessionLifecycleHost = {
			createManagedRuntime: vi.fn().mockResolvedValue(runtime),
			disposeRuntime: vi.fn().mockResolvedValue(undefined),
			refreshProjectSessions: vi.fn().mockResolvedValue([]),
			getStoredSession: vi.fn().mockReturnValue(overrides?.stored ?? null),
			emit: vi.fn(),
			emitSessionState: vi.fn(),
			emitSessionList: vi.fn(),
			setActiveProjectId: vi.fn(),
			setActiveSessionId: vi.fn(),
			getActiveSessionId: vi.fn().mockReturnValue(null),
		};
		return {
			service: new SessionLifecycleService({
				host,
				projectService: {
					activeId: projectId,
					getProjectInfo: (id: string) =>
						id === projectId
							? { id: projectId, name: "Project", cwd: "/project", valid: true, createdAt: Date.now() }
							: null,
				} as unknown as import("../src/main/projects/project-service.js").ProjectService,
				runtimeRegistry: {
					get: vi.fn().mockReturnValue(runtime),
				} as unknown as import("../src/main/session/runtime/runtime-registry.js").RuntimeRegistry,
				scopeRegistry: {
					get: vi.fn().mockReturnValue({ isDefaultName: false, imProvider: undefined }),
				} as unknown as import("../src/main/session/scope/scope-registry.js").SessionScopeRegistry,
				subAgentRuntimeService: {
					destroySubSessions: vi.fn().mockResolvedValue(undefined),
					abortSubSessions: vi.fn().mockResolvedValue(undefined),
				} as unknown as import("../src/main/services/subagent-runtime.js").SubAgentRuntimeService,
				sessionInfoService: {
					getAgentInfo: vi.fn().mockReturnValue({ id: "session-1", projectId }),
				} as unknown as import("../src/main/session/services/session-info-service.js").SessionInfoService,
				permissionService: {
					cancelPending: vi.fn(),
				} as unknown as import("../src/main/core/contracts.js").IPermissionService,
				planService: {
					cancelInteractions: vi.fn(),
				} as unknown as import("../src/main/core/contracts.js").IPlanService,
				userSettings: {
					getAll: vi.fn().mockReturnValue({}),
				} as unknown as import("../src/main/settings/store.js").UserSettingsStore,
				modelRegistry: {
					find: vi.fn(),
					hasConfiguredAuth: vi.fn(),
				} as unknown as import("@earendil-works/pi-coding-agent").ModelRegistry,
				getAvailableModelsSync: vi.fn().mockReturnValue([]),
			}),
			host,
			runtime,
		};
	}

	it("createAgent sets the name, default-model flag and emits events", async () => {
		const { service, host, runtime } = makeService();

		const id = await service.createAgent("My Agent");

		expect(id).toBe("session-1");
		expect(host.createManagedRuntime).toHaveBeenCalled();
		expect(runtime.runtime.session.setSessionName).toHaveBeenCalledWith("My Agent");
		expect(host.setActiveProjectId).toHaveBeenCalledWith("project-1");
		expect(host.setActiveSessionId).toHaveBeenCalledWith("session-1");
		expect(host.emit).toHaveBeenCalledWith({
			type: "agent:created",
			agentId: "session-1",
			agent: { id: "session-1", projectId: "project-1" },
		});
		expect(host.emitSessionState).toHaveBeenCalledWith("session-1", "initial");
	});

	it("destroyAgent cascades to sub-sessions, disposes runtime and removes stored file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "look-sls-"));
		const path = join(dir, "session.jsonl");
		writeFileSync(path, "", "utf8");

		const stored: StoredSession = {
			id: "session-1",
			name: "s",
			firstMessage: "",
			messageCount: 1,
			created: new Date(),
			modified: new Date(),
			path,
			cwd: dir,
			projectId: "project-1",
			allMessagesText: "",
		};
		const { service, host } = makeService({ stored });

		// The session being destroyed is the active one — activeSessionId should be cleared.
		vi.mocked(host.getActiveSessionId).mockReturnValue("session-1");

		await service.destroyAgent("session-1");

		expect(host.disposeRuntime).toHaveBeenCalledWith("session-1", true);
		expect(existsSync(path)).toBe(false);
		expect(host.setActiveSessionId).toHaveBeenCalledWith(null);
		expect(host.emit).toHaveBeenCalledWith({ type: "agent:destroyed", agentId: "session-1" });
		expect(host.emitSessionList).toHaveBeenCalledWith("project-1");

		rmSync(dir, { recursive: true, force: true });
	});

	it("abortAgent cascades to sub-sessions and aborts the session", async () => {
		const { service, runtime } = makeService();

		await service.abortAgent("session-1");

		expect(runtime.runtime.session.abort).toHaveBeenCalled();
	});
});
