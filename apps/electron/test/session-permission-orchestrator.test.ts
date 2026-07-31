// ============================================================
// SessionPermissionOrchestrator unit tests
// ============================================================

import type { ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "@look/shared/types";
import { describe, expect, it, vi } from "vitest";
import type { IEventBus, IPermissionService, IPlanService } from "../src/main/core/contracts.js";
import type { ManagedRuntime } from "../src/main/session/runtime/runtime-registry.js";
import { SessionPermissionOrchestrator } from "../src/main/session/services/session-permission-orchestrator.js";
import type { UserSettingsStore } from "../src/main/settings/store.js";

function makeEventBus(): IEventBus {
	return { emit: vi.fn(), onEvent: vi.fn() };
}

function makeModelRegistry(): Pick<ModelRegistry, "find"> {
	return { find: vi.fn() };
}

function makeUserSettings(planModel: string | null = null) {
	return {
		update: vi.fn(),
		getAll: vi.fn(() => ({ planModel })),
	} as unknown as UserSettingsStore;
}

function makeManagedRuntime(isStreaming = false): ManagedRuntime {
	const sessionManager = {} as SessionManager;
	return {
		runtime: {
			session: {
				isStreaming,
				abort: vi.fn(),
				model: undefined,
				setModel: vi.fn(() => Promise.resolve(true)),
			},
		},
		projectId: "p1",
		binding: { sessionId: "s1", sessionManager },
		createdAt: 1,
		unsubscribe: () => {},
	} as unknown as ManagedRuntime;
}

describe("SessionPermissionOrchestrator", () => {
	it("no-ops when mode is unchanged", async () => {
		const permissionService = {
			getMode: vi.fn(() => "ask" as PermissionMode),
			setMode: vi.fn(),
			persistIfDirty: vi.fn(),
			setDefaultMode: vi.fn(),
		} as unknown as IPermissionService;

		const orchestrator = new SessionPermissionOrchestrator({
			host: { ensureRuntime: vi.fn(() => Promise.resolve(makeManagedRuntime())) },
			eventBus: makeEventBus(),
			permissionService,
			planService: { cancelInteractions: vi.fn() } as unknown as IPlanService,
			userSettings: makeUserSettings(),
			modelRegistry: makeModelRegistry(),
		});

		await orchestrator.applyMode("s1", "ask", { internal: false, updateDefault: true });
		expect(permissionService.setMode).not.toHaveBeenCalled();
	});

	it("captures plan tools, restricts, and persists when entering plan", async () => {
		const modes: Record<string, PermissionMode> = { s1: "ask" };
		const permissionService = {
			getMode: vi.fn((id: string) => modes[id]),
			setMode: vi.fn((id: string, mode: PermissionMode) => {
				modes[id] = mode;
			}),
			persistIfDirty: vi.fn(),
			setDefaultMode: vi.fn(),
		} as unknown as IPermissionService;

		const planService = {
			cancelInteractions: vi.fn(),
			capturePrePlanTools: vi.fn(),
			restrictToolsForPlan: vi.fn(),
			persistToolSnapshotIfDirty: vi.fn(),
		} as unknown as IPlanService;

		const orchestrator = new SessionPermissionOrchestrator({
			host: { ensureRuntime: vi.fn(() => Promise.resolve(makeManagedRuntime())) },
			eventBus: makeEventBus(),
			permissionService,
			planService,
			userSettings: makeUserSettings(),
			modelRegistry: makeModelRegistry(),
		});

		await orchestrator.applyMode("s1", "plan", { internal: false, updateDefault: false });
		expect(planService.capturePrePlanTools).toHaveBeenCalledWith("s1");
		expect(planService.restrictToolsForPlan).toHaveBeenCalledWith("s1");
		expect(permissionService.setMode).toHaveBeenCalledWith("s1", "plan");
		expect(permissionService.persistIfDirty).toHaveBeenCalledWith("s1", expect.anything());
		expect(planService.persistToolSnapshotIfDirty).toHaveBeenCalledWith("s1", expect.anything());
	});
});
