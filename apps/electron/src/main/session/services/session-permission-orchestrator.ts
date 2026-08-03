// ============================================================
// SessionPermissionOrchestrator — permission/plan mode transitions
//
// Owns the cross-service transaction of switching a session's
// permission mode: cancelling plan interactions, capturing/restoring
// tool snapshots, switching models for Plan mode, updating defaults,
// and aborting streaming when entering/leaving plan mode.
//
// Model switching for Plan mode is a *temporary* session-level change.
// Two invariants are enforced:
//   1. It must never block the permission-mode transition (best-effort,
//      failures are logged and the mode switch still completes).
//   2. It must never pollute the user's global default model: the SDK's
//      session.setModel persists setDefaultModelAndProvider, so we capture
//      and restore the global default model around every plan switch.
// ============================================================

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "@look/shared/types";
import type { IEventBus, IPermissionService, IPlanService } from "../../core/contracts.js";
import type { UserSettingsStore } from "../../settings/store.js";
import type { ManagedRuntime } from "../runtime/runtime-registry.js";

export interface SessionPermissionOrchestratorHost {
	ensureRuntime(sessionId: string): Promise<ManagedRuntime>;
	/** Push a fresh agent snapshot so the renderer reflects the model switch immediately. */
	emitSessionUpdated(sessionId: string): void;
}

export interface SessionPermissionOrchestratorDependencies {
	host: SessionPermissionOrchestratorHost;
	eventBus: IEventBus;
	permissionService: IPermissionService;
	planService: IPlanService;
	userSettings: UserSettingsStore;
	modelRegistry: Pick<ModelRegistry, "find">;
}

/** Everything needed to restore the pre-plan state of one session. */
interface PlanModelRestorePoint {
	/** Session model key when entering Plan mode (null = session had no model). */
	modelKey: string | null;
	/** Global default model key when entering Plan mode (null = no default). */
	defaultModelKey: string | null;
	/** The planModel key used for this switch, to detect manual changes during Plan. */
	planModelKey: string;
}

export class SessionPermissionOrchestrator {
	/** Pre-plan restore point saved per session so we can restore it when leaving plan mode. */
	private readonly prePlanModel = new Map<string, PlanModelRestorePoint>();
	/** Per-session serialization queue for applyMode (rapid enter/exit must not interleave). */
	private readonly applyQueues = new Map<string, Promise<void>>();

	constructor(private readonly deps: SessionPermissionOrchestratorDependencies) {}

	/** Serialize applyMode per session so concurrent IPC calls cannot interleave. */
	async applyMode(
		sessionId: string,
		mode: PermissionMode,
		options: { internal: boolean; updateDefault: boolean },
	): Promise<void> {
		const previous = this.applyQueues.get(sessionId) ?? Promise.resolve();
		const next = previous.then(
			() => this.applyModeInner(sessionId, mode, options),
			() => this.applyModeInner(sessionId, mode, options),
		);
		this.applyQueues.set(sessionId, next);
		void next.finally(() => {
			if (this.applyQueues.get(sessionId) === next) this.applyQueues.delete(sessionId);
		});
		return next;
	}

	/** Clean up per-session state when a runtime is disposed. */
	disposeSession(sessionId: string): void {
		this.prePlanModel.delete(sessionId);
		this.applyQueues.delete(sessionId);
	}

	private async applyModeInner(
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
		// Best-effort and never blocks the mode transition. On success we push
		// agent:updated so the renderer model selector shows the new model
		// immediately (the SDK's model_select event is not translated to a Look
		// UI snapshot).
		if (mode === "plan") {
			await this.applyPlanModel(sessionId, managed);
		} else if (previousMode === "plan") {
			await this.restorePlanModel(sessionId, managed);
		}

		if (options.updateDefault) {
			this.deps.permissionService.setDefaultMode(mode);
			try {
				await this.deps.userSettings.update({ permissionMode: mode });
			} catch (error) {
				// Persisting the default mode must not break the transition either.
				console.warn(`[Look][Plan] Failed to persist default permission mode ${mode}:`, error);
			}
		}

		if (!options.internal && managed.runtime.session.isStreaming && (previousMode === "plan" || mode === "plan")) {
			await managed.runtime.session.abort();
		}

		// Broadcast mode change so the renderer can sync permissionModeAtomFamily.
		this.deps.eventBus.emit({ type: "permission:mode-changed", agentId: sessionId, mode });
	}

	// ── Plan model helpers ──

	private currentModelKey(session: ManagedRuntime["runtime"]["session"]): string | null {
		return session.model ? `${session.model.provider}/${session.model.id}` : null;
	}

	/** Restore the global default model captured before the plan switch. */
	private async restoreDefaultModel(defaultModelKey: string | null): Promise<void> {
		try {
			await this.deps.userSettings.update({ preferredModel: defaultModelKey });
		} catch (error) {
			console.warn(`[Look][Plan] Failed to restore default model ${defaultModelKey ?? "none"}:`, error);
		}
	}

	private async applyPlanModel(sessionId: string, managed: ManagedRuntime): Promise<void> {
		const settings = this.deps.userSettings.getAll();
		if (!settings.planModel) return;
		const [provider, ...parts] = settings.planModel.split("/");
		const modelId = parts.join("/");
		if (!modelId) {
			console.warn(`[Look][Plan] Invalid planModel (expected provider/modelId): ${settings.planModel}`);
			return;
		}
		const planModel = this.deps.modelRegistry.find(provider, modelId);
		if (!planModel) {
			console.warn(`[Look][Plan] Plan model not found: ${settings.planModel}`);
			return;
		}
		// The restore point is saved synchronously before the async switch so an
		// exit that runs right after (e.g. a queued applyMode("ask")) always sees it.
		this.prePlanModel.set(sessionId, {
			modelKey: this.currentModelKey(managed.runtime.session),
			defaultModelKey: settings.preferredModel,
			planModelKey: settings.planModel,
		});
		try {
			await managed.runtime.session.setModel(planModel);
			// SDK setModel persists setDefaultModelAndProvider as a side effect;
			// a temporary Plan switch must not pollute the user's global default.
			await this.restoreDefaultModel(settings.preferredModel);
		} catch (error) {
			// setModel validates auth internally and throws when the provider has
			// no usable credentials. Model stays unchanged — no restore point.
			this.prePlanModel.delete(sessionId);
			console.warn(`[Look][Plan] Failed to switch to plan model ${settings.planModel}:`, error);
			return;
		}
		this.deps.host.emitSessionUpdated(sessionId);
	}

	private async restorePlanModel(sessionId: string, managed: ManagedRuntime): Promise<void> {
		const restore = this.prePlanModel.get(sessionId);
		if (!restore) return;
		// Global default model is always restored to the pre-plan value.
		await this.restoreDefaultModel(restore.defaultModelKey);
		// Session model is restored only when the user did not manually switch
		// models while in Plan mode (current model is still the planModel).
		if (this.currentModelKey(managed.runtime.session) !== restore.planModelKey) {
			this.prePlanModel.delete(sessionId);
			return;
		}
		const restoreKey = restore.modelKey ?? restore.defaultModelKey;
		if (!restoreKey) {
			// Session had no model and no global default before Plan: the SDK has
			// no API to clear a session model, so planModel remains (known tradeoff).
			this.prePlanModel.delete(sessionId);
			return;
		}
		const [provider, ...parts] = restoreKey.split("/");
		const modelId = parts.join("/");
		const previousModel = this.deps.modelRegistry.find(provider, modelId);
		if (!previousModel) {
			console.warn(`[Look][Plan] Pre-plan model not found: ${restoreKey}`);
			this.prePlanModel.delete(sessionId);
			return;
		}
		try {
			await managed.runtime.session.setModel(previousModel);
			// Only remove the restore point after a successful restore so a
			// transient failure can be retried on a later exit.
			this.prePlanModel.delete(sessionId);
			this.deps.host.emitSessionUpdated(sessionId);
		} catch (error) {
			console.warn(`[Look][Plan] Failed to restore model ${restoreKey}:`, error);
		}
	}
}
