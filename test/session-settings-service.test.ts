import type { AgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { UserSettings } from "@look/shared/types";
import { describe, expect, it, vi } from "vitest";
import type { ManagedRuntime } from "../src/main/session/runtime-registry.js";
import { SessionSettingsService } from "../src/main/session/session-settings-service.js";

const SETTINGS: UserSettings = {
	language: "en",
	autoCollapse: true,
	compactionEnabled: true,
	permissionMode: "ask",
	preferredModel: null,
	lastActiveSessionId: "missing-session",
	lastActiveProjectId: "missing-project",
	openProjectIds: ["project-1", "missing-project"],
	openedSessionIds: ["session-1", "missing-session"],
	themeTone: "dark",
	autoTitleModel: null,
	subagentEnabled: true,
	enabledAgentDefinitions: null,
	enabledSkills: null,
	sidebarCollapsed: false,
	rightPanelCollapsed: false,
};

function makeService() {
	const setAutoCompactionEnabled = vi.fn();
	const runtime = {
		runtime: { session: { setAutoCompactionEnabled } } as unknown as AgentSessionRuntime,
		projectId: "project-1",
		cwd: "/project",
		createdAt: 1,
		binding: { sessionId: "session-1", sessionManager: {} as SessionManager },
		unsubscribe: vi.fn(),
	} satisfies ManagedRuntime;
	const userSettings = {
		getAll: vi.fn(() => structuredClone(SETTINGS)),
		update: vi.fn(async (partial: Partial<UserSettings>) => ({ ...SETTINGS, ...partial })),
		reset: vi.fn(async () => structuredClone(SETTINGS)),
	};
	const options = {
		userSettings,
		listProjects: () => [{ id: "project-1", name: "Project", cwd: "/project", createdAt: 1, valid: true }],
		getActiveProject: () => null,
		listSessionIds: () => ["session-1"],
		listRuntimes: () => [runtime].values(),
		listRuntimeIds: () => ["session-1"].values(),
		permissionService: { setDefaultMode: vi.fn() },
		sessionSubagentService: {
			setDefaultEnabled: vi.fn(),
			setEnabledForSession: vi.fn().mockResolvedValue(undefined),
		},
		projectTrustDefaults: { setDefaultProjectTrust: vi.fn() },
	};
	return { service: new SessionSettingsService(options), options, setAutoCompactionEnabled };
}

describe("SessionSettingsService", () => {
	it("filters stale project and session references on read", () => {
		const { service } = makeService();
		expect(service.get()).toMatchObject({
			openProjectIds: ["project-1"],
			openedSessionIds: ["session-1"],
			lastActiveProjectId: "project-1",
			lastActiveSessionId: "",
		});
	});

	it("sanitizes a copy before persisting and broadcasts runtime settings", async () => {
		const { service, options, setAutoCompactionEnabled } = makeService();
		const input: Partial<UserSettings> = {
			openProjectIds: ["project-1", "missing-project"],
			openedSessionIds: ["session-1", "missing-session"],
			lastActiveProjectId: "missing-project",
			lastActiveSessionId: "missing-session",
			compactionEnabled: false,
			permissionMode: "plan",
			subagentEnabled: false,
		};

		await service.update(input);

		expect(input.openProjectIds).toEqual(["project-1", "missing-project"]);
		expect(options.userSettings.update).toHaveBeenCalledWith({
			...input,
			openProjectIds: ["project-1"],
			openedSessionIds: ["session-1"],
			lastActiveProjectId: "",
			lastActiveSessionId: "",
		});
		expect(setAutoCompactionEnabled).toHaveBeenCalledWith(false);
		expect(options.permissionService.setDefaultMode).toHaveBeenCalledWith("plan");
		expect(options.sessionSubagentService.setDefaultEnabled).toHaveBeenCalledWith(false);
		expect(options.sessionSubagentService.setEnabledForSession).toHaveBeenCalledWith("session-1", false);
	});

	it("restores cross-service defaults when settings reset", async () => {
		const { service, options } = makeService();
		await service.reset();
		expect(options.permissionService.setDefaultMode).toHaveBeenCalledWith("ask");
		expect(options.sessionSubagentService.setDefaultEnabled).toHaveBeenCalledWith(true);
		expect(options.projectTrustDefaults.setDefaultProjectTrust).toHaveBeenCalledWith("ask");
	});
});
