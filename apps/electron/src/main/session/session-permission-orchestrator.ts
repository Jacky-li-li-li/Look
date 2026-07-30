// ============================================================
// SessionPermissionOrchestrator — permission/plan mode transitions
//
// Owns the cross-service transaction of switching a session's
// permission mode: cancelling plan interactions, capturing/restoring
// tool snapshots, switching models for Plan mode, updating defaults,
// and aborting streaming when entering/leaving plan mode.
// ============================================================

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
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
	modelRegistry: Pick<ModelRegistry, "find">;
}

export class SessionPermissionOrchestrator {
	/** Pre-plan model key saved per session so we can restore it when leaving plan mode. */
	private readonly prePlanModelKey = new Map<string, string | null>();

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

		// ── Plan mode model switching ──
		if (mode === "plan") {
			const settings = this.deps.userSettings.getAll();
			if (settings.planModel) {
				const [provider, ...parts] = settings.planModel.split("/");
				const modelId = parts.join("/");
				const planModel = this.deps.modelRegistry.find(provider, modelId);
				if (planModel) {
					const currentModel = managed.runtime.session.model;
					const currentKey = currentModel ? `${currentModel.provider}/${currentModel.id}` : null;
					this.prePlanModelKey.set(sessionId, currentKey);
					await managed.runtime.session.setModel(planModel);
				}
			}
		} else if (previousMode === "plan") {
			const savedKey = this.prePlanModelKey.get(sessionId);
			this.prePlanModelKey.delete(sessionId);
			if (savedKey !== undefined && savedKey !== null) {
				const [provider, ...parts] = savedKey.split("/");
				const modelId = parts.join("/");
				const previousModel = this.deps.modelRegistry.find(provider, modelId);
				if (previousModel) {
					await managed.runtime.session.setModel(previousModel);
				}
			}
		}

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
