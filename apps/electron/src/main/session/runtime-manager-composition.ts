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
 * builder 阶段产物的运行时必填校验：把"某个服务漏装配"从下游的
 * `undefined is not a function` 提前为启动期带字段名的明确错误，
 * 取代原先 35 处非空断言 `builder.x!`。
 */
function required<T>(value: T | null | undefined, name: string): T {
	if (value === null || value === undefined) {
		throw new Error(`[RuntimeManagerComposition] builder did not initialize "${name}"`);
	}
	return value;
}

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
	readonly browserService;
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

		this.trustStore = required(builder.trustStore, "trustStore");
		this.globalSettingsManager = required(builder.globalSettingsManager, "globalSettingsManager");
		this.projectService = required(builder.projectService, "projectService");
		this.userSettings = required(builder.userSettings, "userSettings");
		this.permissionService = required(builder.permissionService, "permissionService");
		this.promptStore = required(builder.promptStore, "promptStore");
		this.mcpManager = required(builder.mcpManager, "mcpManager");
		this.browserService = required(builder.browserService, "browserService");
		this.sessionCatalog = required(builder.sessionCatalog, "sessionCatalog");
		this.draftIndex = builder.draftIndex;
		this.projectRuntimeService = required(builder.projectRuntimeService, "projectRuntimeService");
		this.sessionInfoService = required(builder.sessionInfoService, "sessionInfoService");
		this.sessionNotifier = required(builder.sessionNotifier, "sessionNotifier");
		this.eventProcessor = required(builder.eventProcessor, "eventProcessor");
		this.subAgentRuntimeService = required(builder.subAgentRuntimeService, "subAgentRuntimeService");
		this.projectApplicationService = required(builder.projectApplicationService, "projectApplicationService");

		this.modelRuntime = required(builder.modelRuntime, "modelRuntime");
		this.modelRegistry = required(builder.modelRegistry, "modelRegistry");
		this.credentialStore = required(builder.credentialStore, "credentialStore");
		this.customProviders = required(builder.customProviders, "customProviders");

		this.autoTitleService = required(builder.autoTitleService, "autoTitleService");
		this.runtimeFactory = required(builder.runtimeFactory, "runtimeFactory");

		this.planService = required(builder.planService, "planService");
		this.agentDefinitionService = required(builder.agentDefinitionService, "agentDefinitionService");
		this.sessionSubagentService = required(builder.sessionSubagentService, "sessionSubagentService");
		this.runtimeLifecycle = required(builder.runtimeLifecycle, "runtimeLifecycle");

		this.sessionHistoryService = required(builder.sessionHistoryService, "sessionHistoryService");
		this.sessionControlService = required(builder.sessionControlService, "sessionControlService");
		this.sessionLifecycleService = required(builder.sessionLifecycleService, "sessionLifecycleService");
		this.projectDeletionService = required(builder.projectDeletionService, "projectDeletionService");
		this.sessionMessagingService = required(builder.sessionMessagingService, "sessionMessagingService");
		this.sessionPermissionOrchestrator = required(
			builder.sessionPermissionOrchestrator,
			"sessionPermissionOrchestrator",
		);
		this.sessionEventEffects = required(builder.sessionEventEffects, "sessionEventEffects");
		this.sessionSettingsService = required(builder.sessionSettingsService, "sessionSettingsService");
		this.skillManagementService = required(builder.skillManagementService, "skillManagementService");
		this.attachmentService = required(builder.attachmentService, "attachmentService");
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
