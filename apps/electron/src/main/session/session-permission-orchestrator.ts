// ============================================================
// SessionPermissionOrchestrator — permission/plan mode transitions
//
// Owns the cross-service transaction of switching a session's
// permission mode: cancelling plan interactions, capturing/restoring
// tool snapshots, updating defaults, and aborting streaming when
// entering/leaving plan mode.
// ============================================================

import type { PermissionMode } from "@look/shared/types";
import type { IEventBus, IPermissionService, IPlanService } from "../core/contracts.js";
import type { UserSettingsStore } from "../settings/store.js";
import type { ManagedRuntime } from "./runtime-registry.js";

export interface SessionPermissionOrchestratorHost {
	ensureRuntime(sessionId: string): Promise<ManagedRuntime>;
}

export interface SessionPermissionOrchestratorDependencies {
	host: SessionPermissionOrchestratorHost;
	eventBus: IEventBus;
	permissionService: IPermissionService;
	planService: IPlanService;
	userSettings: UserSettingsStore;
}

export class SessionPermissionOrchestrator {
	constructor(private readonly deps: SessionPermissionOrchestratorDependencies) {}

	async applyMode(
		sessionId: string,
		mode: PermissionMode,
		options: { internal: boolean; updateDefault: boolean },
	): Promise<void> {
		const managed = await this.deps.host.ensureRuntime(sessionId);
		const previousMode = this.deps.permissionService.getMode(sessionId);
		if (previousMode === mode) return;

		if (!options.internal) {
			this.deps.planService.cancelInteractions(sessionId, "Permission mode was changed manually");
		}
		if (mode === "plan") this.deps.planService.capturePrePlanTools(sessionId);

		this.deps.permissionService.setMode(sessionId, mode);
		if (mode === "plan") this.deps.planService.restrictToolsForPlan(sessionId);
		else if (previousMode === "plan") this.deps.planService.restorePrePlanTools(sessionId);
		this.deps.permissionService.persistIfDirty(sessionId, managed.binding.sessionManager);
		this.deps.planService.persistToolSnapshotIfDirty(sessionId, managed.binding.sessionManager);

		if (options.updateDefault) {
			this.deps.permissionService.setDefaultMode(mode);
			await this.deps.userSettings.update({ permissionMode: mode });
		}

		if (!options.internal && managed.runtime.session.isStreaming && (previousMode === "plan" || mode === "plan")) {
			await managed.runtime.session.abort();
		}

		// Broadcast mode change so the renderer can sync permissionModeAtomFamily.
		this.deps.eventBus.emit({ type: "permission:mode-changed", agentId: sessionId, mode });
	}
}
