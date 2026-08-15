// ============================================================
// RuntimeManagerComposition — immutable service holder
//
// Created by CompositionBuilder.build(). All fields are guaranteed
// non-null after construction (validated by builder.validate()). `!`
// assertions in the constructor are guarded by this validation.
//
// Use `RuntimeManagerComposition.create()` instead of `new`.
// ============================================================

import type { SchedulerService } from "../scheduler/scheduler-service.js";
import type { WorkspaceFileService } from "../workspace/workspace-file-service.js";
import type { WorkspaceTreeService } from "../workspace/workspace-tree-service.js";
import { CompositionBuilder } from "./composition/builder.js";

/**
 * Immutable holder of all domain services for the session runtime.
 *
 * Construction is orchestrated by CompositionBuilder; use the static
 * `create()` factory instead of calling the constructor directly.
 */
export class RuntimeManagerComposition {
	// ── All fields readonly and guaranteed non-null ──

	readonly eventBus;
	readonly runtimeRegistry;
	readonly scopeRegistry;
	readonly subAgentRegistry;
	readonly activeSessionSelection;

	readonly trustStore;
	readonly globalSettingsManager;
	readonly projectService;
	readonly userSettings;
	readonly permissionService;
	readonly promptStore;
	readonly mcpManager;
	readonly sessionCatalog;
	readonly draftIndex;
	readonly projectRuntimeService;
	readonly sessionInfoService;
	readonly sessionNotifier;
	readonly eventProcessor;
	readonly subAgentRuntimeService;
	readonly projectApplicationService;

	readonly modelRuntime;
	readonly modelRegistry;
	readonly credentialStore;
	readonly customProviders;

	readonly autoTitleService;
	readonly runtimeFactory;

	readonly planService;
	readonly agentDefinitionService;
	readonly sessionSubagentService;
	readonly runtimeLifecycle;

	readonly sessionHistoryService;
	readonly sessionControlService;
	readonly sessionLifecycleService;
	readonly projectDeletionService;
	readonly sessionMessagingService;
	readonly sessionPermissionOrchestrator;
	readonly sessionEventEffects;
	readonly sessionSettingsService;
	readonly skillManagementService;
	readonly attachmentService;

	readonly workspaceFileService;
	readonly workspaceTreeService;

	private readonly schedulerRef: { current: SchedulerService | null };

	private constructor(
		workspaceFileService: WorkspaceFileService | null,
		workspaceTreeService: WorkspaceTreeService | null,
		builder: CompositionBuilder,
	) {
		this.schedulerRef = builder.schedulerRef;
		this.workspaceFileService = workspaceFileService;
		this.workspaceTreeService = workspaceTreeService;

		// Copy validated fields from builder — guaranteed non-null by builder.build()
		this.eventBus = builder.eventBus;
		this.runtimeRegistry = builder.runtimeRegistry;
		this.scopeRegistry = builder.scopeRegistry;
		this.subAgentRegistry = builder.subAgentRegistry;
		this.activeSessionSelection = builder.activeSessionSelection;

		this.trustStore = builder.trustStore!;
		this.globalSettingsManager = builder.globalSettingsManager!;
		this.projectService = builder.projectService!;
		this.userSettings = builder.userSettings!;
		this.permissionService = builder.permissionService!;
		this.promptStore = builder.promptStore!;
		this.mcpManager = builder.mcpManager!;
		this.sessionCatalog = builder.sessionCatalog!;
		this.draftIndex = builder.draftIndex;
		this.projectRuntimeService = builder.projectRuntimeService!;
		this.sessionInfoService = builder.sessionInfoService!;
		this.sessionNotifier = builder.sessionNotifier!;
		this.eventProcessor = builder.eventProcessor!;
		this.subAgentRuntimeService = builder.subAgentRuntimeService!;
		this.projectApplicationService = builder.projectApplicationService!;

		this.modelRuntime = builder.modelRuntime!;
		this.modelRegistry = builder.modelRegistry!;
		this.credentialStore = builder.credentialStore!;
		this.customProviders = builder.customProviders!;

		this.autoTitleService = builder.autoTitleService!;
		this.runtimeFactory = builder.runtimeFactory!;

		this.planService = builder.planService!;
		this.agentDefinitionService = builder.agentDefinitionService!;
		this.sessionSubagentService = builder.sessionSubagentService!;
		this.runtimeLifecycle = builder.runtimeLifecycle!;

		this.sessionHistoryService = builder.sessionHistoryService!;
		this.sessionControlService = builder.sessionControlService!;
		this.sessionLifecycleService = builder.sessionLifecycleService!;
		this.projectDeletionService = builder.projectDeletionService!;
		this.sessionMessagingService = builder.sessionMessagingService!;
		this.sessionPermissionOrchestrator = builder.sessionPermissionOrchestrator!;
		this.sessionEventEffects = builder.sessionEventEffects!;
		this.sessionSettingsService = builder.sessionSettingsService!;
		this.skillManagementService = builder.skillManagementService!;
		this.attachmentService = builder.attachmentService!;
	}

	// ── Static async factory ──

	static async create(
		workspaceFileService: WorkspaceFileService | null,
		workspaceTreeService: WorkspaceTreeService | null,
	): Promise<RuntimeManagerComposition> {
		const builder = new CompositionBuilder();

		builder.buildInfra(workspaceFileService, workspaceTreeService);
		await builder.buildModel();
		builder.buildExtensions();
		builder.buildCore();
		builder.buildUI();
		builder.validate();

		return new RuntimeManagerComposition(
			builder.getWorkspaceFileService(),
			builder.getWorkspaceTreeService(),
			builder,
		);
	}

	// ── Mutable cross-cutting ──

	/**
	 * Late-set the scheduler service after construction.
	 *
	 * This setter exists to resolve a genuine circular dependency:
	 *   - Composition needs schedulerService (via schedulerRef)
	 *   - SchedulerService needs RuntimeManagerComposition (as executor)
	 *
	 * The resolution order in index.ts is:
	 *   1. Create runtimeManager (composition is built, schedulerRef starts null)
	 *   2. Create schedulerService (receives runtimeManager via executor closure)
	 *   3. Call setSchedulerService() to wire the reference back
	 *
	 * This is intentional, not a DI design flaw. An alternative would be a
	 * factory-lambda with lazy resolution, but that complicates every call site
	 * with an extra indirection; a single post-construction setter is simpler
	 * and the mutation is contained to one well-defined point.
	 */
	setSchedulerService(schedulerService: SchedulerService): void {
		this.schedulerRef.current = schedulerService;
	}
}
