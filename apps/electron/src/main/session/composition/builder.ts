// ============================================================
// CompositionBuilder — phase wiring shell
//
// Class fields / helpers / validate live in builder-context.ts
// (no back-edge to phases). This module one-way depends on phases.
// ============================================================

import type { WorkspaceFileService } from "../../workspace/workspace-file-service.js";
import type { WorkspaceTreeService } from "../../workspace/workspace-tree-service.js";
import { CompositionBuilder as CompositionBuilderBase } from "./builder-context.js";
import { buildCorePhase } from "./builder-phases/core.js";
import { buildExtensionsPhase } from "./builder-phases/extensions.js";
import { buildInfraPhase } from "./builder-phases/infra.js";
import { buildModelPhase } from "./builder-phases/model.js";
import { buildUIPhase } from "./builder-phases/ui.js";

export { MAX_SUBAGENT_DEPTH } from "./builder-context.js";

/**
 * Mutable builder that orchestrates service creation in dependency order.
 * Phase methods delegate to builder-phases/*; shared state lives on the base.
 */
export class CompositionBuilder extends CompositionBuilderBase {
	// ── Phase 1: Infrastructure (sync) ──
	buildInfra(
		workspaceFileService: WorkspaceFileService | null,
		workspaceTreeService: WorkspaceTreeService | null,
	): void {
		buildInfraPhase(this, workspaceFileService, workspaceTreeService);
	}

	// ── Phase 2: Model runtime (async) ──
	/**
	 * Phase 2: Build the model layer.
	 *
	 * Creates global singletons: ModelRuntime, ModelRegistry, CredentialStore,
	 * CustomProvidersStore, and AutoTitleService. This phase must complete before
	 * any session runtime is created (Phase 3) because runtime factories consume
	 * the ModelRuntime.
	 *
	 * Inputs: None (pure initialization from disk)
	 * Outputs: modelRuntime, modelRegistry, credentialStore, customProviders, autoTitleService
	 */
	async buildModel(): Promise<void> {
		return buildModelPhase(this);
	}

	// ── Phase 3: Extensions (runtimeFactory + extension factories) ──
	/**
	 * Phase 3: Build extension factories and the runtime factory.
	 *
	 * Creates ExtensionFactory instances (permission, plan, modelList, subagent,
	 * MCP, skillInject) and the SessionRuntimeFactory. The runtime factory
	 * serializes resource initialization (npm installs) via a Promise chain
	 * to prevent concurrent package installation races.
	 *
	 * Inputs: modelRuntime (from Phase 2), skillDiscoveryService (from Phase 1)
	 * Outputs: runtimeFactory containing createAgentSessionRuntime flow
	 */
	buildExtensions(): void {
		buildExtensionsPhase(this);
	}

	// ── Phase 4: Core services (plan, agentDef, subagent, lifecycle) ──
	/**
	 * Phase 4: Build the core session orchestrators.
	 *
	 * Creates PlanService, AgentDefinitionService, SessionSubagentService,
	 * and the RuntimeLifecycleCoordinator (which manages per-session runtimes).
	 *
	 * The RuntimeLifecycleCoordinator is constructed via a factory closure to
	 * resolve a genuine circular dependency: the coordinator needs references
	 * to services created in Phase 5 (UI layer), while Phase 5 services need
	 * the coordinator. The closure captures `this` which is resolved at call
	 * time — the coordinator is initialized in Phase 4 but its closure won't
	 * execute until Phase 5 completes.
	 *
	 * Inputs: All services from Phase 1-3, schedulerRef (late-bound)
	 * Outputs: planService, agentDefinitionService, sessionSubagentService, runtimeLifecycleCoordinator
	 */
	buildCore(): void {
		buildCorePhase(this);
	}

	// ── Phase 5: UI-facing services ──
	/**
	 * Phase 5: Build the UI-facing services.
	 *
	 * Creates SessionHistoryService, SessionControlService, SessionLifecycleService,
	 * ProjectDeletionService, and related UI-layer orchestrators. These services
	 * consume the RuntimeLifecycleCoordinator from Phase 4.
	 *
	 * Inputs: All services from Phase 1-4
	 * Outputs: sessionHistoryService, sessionControlService, sessionLifecycleService, etc.
	 */
	buildUI(): void {
		buildUIPhase(this);
	}
}
