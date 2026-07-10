// ============================================================
// SessionPermissionOrchestrator unit tests
// ============================================================

import { describe, expect, it, vi } from "vitest";
import type { PermissionMode } from "@look/shared/types";
import { SessionPermissionOrchestrator } from "../src/main/session/session-permission-orchestrator.js";
import type { IPermissionService, IPlanService } from "../src/main/core/contracts.js";
import type { UserSettingsStore } from "../src/main/settings/store.js";
import type { ManagedRuntime } from "../src/main/session/runtime-registry.js";

function makeManagedRuntime(isStreaming = false): ManagedRuntime {
	return {
		runtime: {
			session: {
				isStreaming,
				abort: vi.fn(),
			},
		},
		projectId: "p1",
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
			permissionService,
			planService: { cancelInteractions: vi.fn() } as unknown as IPlanService,
			userSettings: { update: vi.fn() } as unknown as UserSettingsStore,
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
			permissionService,
			planService,
			userSettings: { update: vi.fn() } as unknown as UserSettingsStore,
		});

		await orchestrator.applyMode("s1", "plan", { internal: false, updateDefault: false });
		expect(planService.capturePrePlanTools).toHaveBeenCalledWith("s1");
		expect(planService.restrictToolsForPlan).toHaveBeenCalledWith("s1");
		expect(permissionService.setMode).toHaveBeenCalledWith("s1", "plan");
	});
});
