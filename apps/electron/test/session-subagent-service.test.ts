// ============================================================
// SessionSubagentService unit tests
// ============================================================

import { describe, expect, it, vi } from "vitest";
import type { AgentSession, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../src/main/extensions/subagent/types.js";
import { SessionSubagentService } from "../src/main/session/session-subagent-service.js";
import type { SessionSubagentHost } from "../src/main/session/session-subagent-service.js";
import type { ManagedRuntime } from "../src/main/session/runtime-registry.js";
import type { ProjectService } from "../src/main/projects/project-service.js";
import type { IPermissionService, IPlanService, ISessionScope } from "../src/main/core/contracts.js";
import type { SubAgentRegistry } from "../src/main/session/subagent-registry.js";
import type { SubAgentRuntimeService } from "../src/main/services/subagent-runtime.js";
import type { UserSettingsStore } from "../src/main/settings/store.js";
import type { AgentDefinitionService } from "../src/main/agents/definition-service.js";
import type { ProjectInfo } from "@look/shared/types";

function makeSession(sessionId: string, activeTools: string[] = [], allTools: string[] = []): AgentSession {
	return {
		sessionId,
		setSessionName: vi.fn(),
		setActiveToolsByName: vi.fn(),
		getActiveToolNames: vi.fn(() => activeTools),
		getAllTools: vi.fn(() => allTools.map((name) => ({ name }))),
		sessionManager: { appendCustomEntry: vi.fn() },
		prompt: vi.fn(() => Promise.resolve()),
		isStreaming: false,
		setModel: vi.fn(),
	} as unknown as AgentSession;
}

function makeManagedRuntime(session: AgentSession, projectId = "p1"): ManagedRuntime {
	return {
		runtime: { session, cwd: "/tmp" },
		projectId,
		cwd: "/tmp",
		createdAt: 1,
		unsubscribe: () => {},
	} as unknown as ManagedRuntime;
}

function makeHost(overrides: Partial<SessionSubagentHost> = {}): SessionSubagentHost {
	return {
		createManagedRuntime: vi.fn(() => Promise.resolve(makeManagedRuntime(makeSession("child")))),
		getManagedRuntime: vi.fn(),
		reloadSession: vi.fn(),
		listRuntimeIds: vi.fn(() => new Map<string, unknown>().keys()),
		getProjectInfo: vi.fn(() => ({ id: "p1", name: "p1", cwd: "/tmp", createdAt: 1, valid: true }) as ProjectInfo),
		emit: vi.fn(),
		emitSessionUpdated: vi.fn(),
		getScope: vi.fn(() => ({}) as ISessionScope),
		acquireScope: vi.fn(() => ({}) as ISessionScope),
		runtimeInfo: vi.fn(() => ({ id: "child", name: "Agent" }) as unknown as import("@look/shared/types").AgentInfo),
		...overrides,
	};
}

describe("SessionSubagentService", () => {
	it("applies default off by removing subagent from active tools", () => {
		const service = new SessionSubagentService({
			host: makeHost(),
			modelRegistry: { find: vi.fn() } as unknown as ModelRegistry,
			subAgentRegistry: { register: vi.fn() } as unknown as SubAgentRegistry,
			subAgentRuntimeService: { setupSubSessionTracking: vi.fn() } as unknown as SubAgentRuntimeService,
			permissionService: { getMode: vi.fn() } as unknown as IPermissionService,
			planService: {} as unknown as IPlanService,
			userSettings: { getAll: vi.fn(() => ({ subagentEnabled: true })) } as unknown as UserSettingsStore,
			agentDefinitionService: {} as unknown as AgentDefinitionService,
			maxSubagentDepth: 5,
			maxNameLength: 80,
		});

		service.setDefaultEnabled(false);
		const session = makeSession("s1", ["read", "subagent"], ["read", "subagent"]);
		service.applyDefaultOnBind("s1", session);
		expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read"]);
	});

	it("rejects an allowlist that contains no valid tools", async () => {
		const childSession = makeSession("child", [], ["read", "edit"]);
		const parentRuntime = makeManagedRuntime(makeSession("parent"), "p1");
		const service = new SessionSubagentService({
			host: makeHost({
				getManagedRuntime: vi.fn(() => parentRuntime),
				createManagedRuntime: vi.fn(() => Promise.resolve(makeManagedRuntime(childSession, "p1"))),
			}),
			modelRegistry: { find: vi.fn() } as unknown as ModelRegistry,
			subAgentRegistry: { getParent: vi.fn(() => null), register: vi.fn() } as unknown as SubAgentRegistry,
			subAgentRuntimeService: { setupSubSessionTracking: vi.fn() } as unknown as SubAgentRuntimeService,
			permissionService: { getMode: vi.fn() } as unknown as IPermissionService,
			planService: {} as unknown as IPlanService,
			userSettings: { getAll: vi.fn(() => ({})) } as unknown as UserSettingsStore,
			agentDefinitionService: {} as unknown as AgentDefinitionService,
			maxSubagentDepth: 5,
			maxNameLength: 80,
		});

		const agent: AgentConfig = {
			name: "test",
			description: "",
			systemPrompt: "",
			tools: ["nonexistent-tool"],
		};

		await expect(service.runSubSession("parent", agent, "task", undefined)).rejects.toThrow(
			'Agent "test" allowlist contains no valid tools',
		);
		expect(childSession.setActiveToolsByName).not.toHaveBeenCalled();
	});

	it("runSubSession throws when parent is not live", async () => {
		const service = new SessionSubagentService({
			host: makeHost({ getManagedRuntime: vi.fn(() => undefined) }),
			modelRegistry: { find: vi.fn() } as unknown as ModelRegistry,
			subAgentRegistry: { getParent: vi.fn(() => null), register: vi.fn() } as unknown as SubAgentRegistry,
			subAgentRuntimeService: {} as unknown as SubAgentRuntimeService,
			permissionService: {} as unknown as IPermissionService,
			planService: {} as unknown as IPlanService,
			userSettings: { getAll: vi.fn(() => ({})) } as unknown as UserSettingsStore,
			agentDefinitionService: {} as unknown as AgentDefinitionService,
			maxSubagentDepth: 5,
			maxNameLength: 80,
		});

		const agent: AgentConfig = {
			name: "test",
			description: "",
			systemPrompt: "",
		};

		await expect(service.runSubSession("parent", agent, "task", undefined)).rejects.toThrow(
			"Parent session parent is not live",
		);
	});
});
