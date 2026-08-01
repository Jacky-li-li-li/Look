// ============================================================
// CompositionBuilder — mutable builder for RuntimeManagerComposition
//
// Owns all services as mutable nullable fields during construction.
// Phase methods populate fields in dependency order. Closures handle
// forward references (circular deps) naturally — the captured `this`
// is resolved at call time, not at capture time.
//
// Once all phases complete, `build()` validates and freezes into an
// immutable RuntimeManagerComposition. This eliminates the `!`-definite
// assertion hack from the previous two-phase constructor pattern.
// ============================================================

import { existsSync } from "node:fs";
import {
	ModelRegistry,
	ModelRuntime,
	ProjectTrustStore,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	ensureLookDir,
	getAuthPath,
	getCustomProvidersPath,
	getLookDir,
	getModelsPath,
	getUiSettingsPath,
	resetLegacySessionsOnce,
} from "@look/shared/look-storage";
import { AgentDefinitionService } from "../../agents/definition-service.js";
import { ComputerUseService } from "../../computer-use/computer-use-service.js";
import { createComputerUseExtensionFactory } from "../../extensions/computer-use-extension.js";
import { createMcpExtensionFactory } from "../../extensions/mcp-extension.js";
import { createModelListExtensionFactory } from "../../extensions/model-extension.js";
import { createPermissionExtensionFactory } from "../../extensions/permission-extension.js";
import { createPlanExtensionFactory } from "../../extensions/plan-extension.js";
import { createSkillInjectExtensionFactory } from "../../extensions/skill-inject-extension.js";
import { discoverAgents } from "../../extensions/subagent/agent-discovery.js";
import { createSubagentExtensionFactory } from "../../extensions/subagent/subagent-extension.js";
import type { AgentConfig, SubagentProgress } from "../../extensions/subagent/types.js";
import { MCPManager } from "../../mcp/manager.js";
import { getAvailableModels } from "../../models/model-queries.js";
import { PlanService } from "../../permissions/plan.js";
import { PermissionService } from "../../permissions/service.js";
import { ProjectDeletionService } from "../../projects/project-deletion-service.js";
import { ProjectService } from "../../projects/project-service.js";
import type { SchedulerService } from "../../scheduler/scheduler-service.js";
import { EncryptedCredentialStore } from "../../security/secrets.js";
import { AutoTitleService } from "../../services/auto-title.js";
import { SubAgentRuntimeService } from "../../services/subagent-runtime.js";
import { CustomProvidersStore } from "../../settings/custom-providers.js";
import { migrateLegacySettings } from "../../settings/migrate.js";
import { PromptStore } from "../../settings/prompt-store.js";
import { UserSettingsStore } from "../../settings/store.js";
import type { WorkspaceFileService } from "../../workspace/workspace-file-service.js";
import type { WorkspaceTreeService } from "../../workspace/workspace-tree-service.js";
import { SessionEventBus } from "../events/session-event-bus.js";
import { SessionEventEffects } from "../events/session-event-effects.js";
import { SessionEventProcessor } from "../events/session-event-processor.js";
import { SessionNotifier } from "../events/session-notifier.js";
import { SessionRuntimeFactory } from "../runtime/runtime-factory.js";
import { RuntimeLifecycleCoordinator } from "../runtime/runtime-lifecycle-coordinator.js";
import { RuntimeRegistry } from "../runtime/runtime-registry.js";
import { ActiveSessionSelection } from "../scope/active-session-selection.js";
import { SessionScopeRegistry } from "../scope/scope-registry.js";
import { ProjectApplicationService } from "../services/project-application-service.js";
import { ProjectRuntimeService } from "../services/project-runtime-service.js";
import { SessionCatalog } from "../services/session-catalog.js";
import { SessionControlService } from "../services/session-control-service.js";
import { SessionHistoryService } from "../services/session-history-service.js";
import { SessionInfoService } from "../services/session-info-service.js";
import { SessionLifecycleService } from "../services/session-lifecycle-service.js";
import { SessionMessagingService } from "../services/session-messaging-service.js";
import { SessionPermissionOrchestrator } from "../services/session-permission-orchestrator.js";
import { SessionSettingsService } from "../services/session-settings-service.js";
import { SessionSubagentService } from "../services/session-subagent-service.js";
import { SkillManagementService } from "../services/skill-management-service.js";
import { SubAgentRegistry } from "../subagent-registry.js";
import { CompositionHost } from "./composition-host.js";

const MAX_NAME_LENGTH = 80;
const MAX_SUBAGENT_DEPTH = 5;

/**
 * Mutable builder that orchestrates service creation in dependency order.
 * All fields start null; phase methods populate them. Closures resolve
 * forward references naturally at call time.
 */
export class CompositionBuilder {
	// ── Owned by the builder (not passed in) ──
	readonly eventBus = new SessionEventBus();
	readonly runtimeRegistry = new RuntimeRegistry();
	readonly scopeRegistry = new SessionScopeRegistry();
	readonly subAgentRegistry = new SubAgentRegistry();
	readonly activeSessionSelection = new ActiveSessionSelection();

	// ── Infra (sync) ──
	trustStore: ProjectTrustStore | null = null;
	globalSettingsManager: SettingsManager | null = null;
	projectService: ProjectService | null = null;
	userSettings: UserSettingsStore | null = null;
	permissionService: PermissionService | null = null;
	promptStore: PromptStore | null = null;
	mcpManager: MCPManager | null = null;
	computerUseService: ComputerUseService | null = null;
	sessionCatalog: SessionCatalog | null = null;
	projectRuntimeService: ProjectRuntimeService | null = null;
	sessionInfoService: SessionInfoService | null = null;
	sessionNotifier: SessionNotifier | null = null;
	eventProcessor: SessionEventProcessor | null = null;
	subAgentRuntimeService: SubAgentRuntimeService | null = null;
	projectApplicationService: ProjectApplicationService | null = null;

	// ── Model (async) ──
	modelRuntime: ModelRuntime | null = null;
	modelRegistry: ModelRegistry | null = null;
	credentialStore: EncryptedCredentialStore | null = null;
	customProviders: CustomProvidersStore | null = null;

	// ── Extensions ──
	autoTitleService: AutoTitleService | null = null;
	runtimeFactory: SessionRuntimeFactory | null = null;

	// ── Core (plan, agentDef, subagent, lifecycle — circular via closures) ──
	planService: PlanService | null = null;
	agentDefinitionService: AgentDefinitionService | null = null;
	sessionSubagentService: SessionSubagentService | null = null;
	runtimeLifecycle: RuntimeLifecycleCoordinator | null = null;

	// ── UI services ──
	sessionHistoryService: SessionHistoryService | null = null;
	sessionControlService: SessionControlService | null = null;
	sessionLifecycleService: SessionLifecycleService | null = null;
	projectDeletionService: ProjectDeletionService | null = null;
	sessionMessagingService: SessionMessagingService | null = null;
	sessionPermissionOrchestrator: SessionPermissionOrchestrator | null = null;
	sessionEventEffects: SessionEventEffects | null = null;
	sessionSettingsService: SessionSettingsService | null = null;
	skillManagementService: SkillManagementService | null = null;

	// ── Mutable cross-cutting reference (shared with composition after build) ──
	readonly schedulerRef: { current: SchedulerService | null } = { current: null };

	private host: CompositionHost | null = null;
	private workspaceFileServiceRef: WorkspaceFileService | null = null;
	private workspaceTreeServiceRef: WorkspaceTreeService | null = null;

	// ── Phase 1: Infrastructure (sync) ──

	buildInfra(
		workspaceFileService: WorkspaceFileService | null,
		workspaceTreeService: WorkspaceTreeService | null,
	): void {
		this.workspaceFileServiceRef = workspaceFileService;
		this.workspaceTreeServiceRef = workspaceTreeService;

		ensureLookDir();
		resetLegacySessionsOnce();
		const migration = migrateLegacySettings();
		if (migration.migrated && migration.keys.length > 0) {
			console.log(`[Look] Migrated settings: ${migration.keys.join(", ")}`);
		}

		this.trustStore = new ProjectTrustStore(getLookDir());
		this.globalSettingsManager = SettingsManager.create(getLookDir(), getLookDir());
		this.projectService = new ProjectService(this.trustStore, this.globalSettingsManager);
		this.userSettings = new UserSettingsStore(this.globalSettingsManager, getUiSettingsPath());
		// NOTE: userSettings MUST be created before permissionService — the
		// PermissionService constructor reads userSettings.getAll().permissionMode.
		// If these lines are reordered, PermissionService will crash on a null ref.
		this.permissionService = new PermissionService(this.eventBus, this.userSettings.getAll().permissionMode);
		// Default to "ask" only when the user has not chosen a policy;
		// setDefaultProjectTrust persists, so an unconditional call would reset
		// an explicitly configured "always"/"never" on every launch.
		if (this.globalSettingsManager.getGlobalSettings().defaultProjectTrust === undefined) {
			this.globalSettingsManager.setDefaultProjectTrust("ask");
		}
		this.promptStore = new PromptStore();

		this.mcpManager = new MCPManager();

		// Computer Use 是进程级 OS 服务（截图/输入与具体会话无关），
		// 与 MCPManager 同为全局共享服务；构造不触碰 Electron API，
		// 真正的 desktopCapturer/nut-js 调用发生在工具执行时（app ready 后）。
		this.computerUseService = new ComputerUseService();

		this.sessionCatalog = new SessionCatalog((metadata) => {
			// Captures CompositionBuilder's subAgentRegistry field (assigned above).
			// `this` refers to the builder, not the SessionCatalog instance.
			if (metadata.parentSessionId) {
				this.subAgentRegistry.register(metadata.parentSessionId, metadata.sessionId, metadata.agentName ?? "");
			}
		});
		this.host = new CompositionHost(
			this.eventBus,
			this.runtimeRegistry,
			this.sessionCatalog,
			this.projectService,
			this.activeSessionSelection,
		);
		const host = this.host;
		this.mcpManager.setOnChange(() => host.emit({ type: "mcp:status-changed" }));
		this.projectRuntimeService = new ProjectRuntimeService({
			projectService: this.projectService,
			sessionCatalog: this.sessionCatalog,
			runtimeRegistry: this.runtimeRegistry,
		});
		this.sessionInfoService = new SessionInfoService({
			runtimeRegistry: this.runtimeRegistry,
			sessionCatalog: this.sessionCatalog,
			subAgentRegistry: this.subAgentRegistry,
			scopeRegistry: this.scopeRegistry,
			maxNameLength: MAX_NAME_LENGTH,
			listProjects: () => host.listProjects(),
		});
		this.sessionNotifier = new SessionNotifier(this.eventBus, {
			sessionInfoService: this.sessionInfoService,
			scopeRegistry: this.scopeRegistry,
			listProjects: () => host.listProjects(),
			getActiveProjectId: () => this.projectService!.activeId,
		});

		this.eventProcessor = new SessionEventProcessor(host, this.scopeRegistry, host);
		this.subAgentRuntimeService = new SubAgentRuntimeService(host, this.subAgentRegistry);

		this.projectApplicationService = new ProjectApplicationService({
			projectService: this.projectService,
			projectRuntimeService: this.projectRuntimeService,
			sessionCatalog: this.sessionCatalog,
			runtimeRegistry: this.runtimeRegistry,
			sessionNotifier: this.sessionNotifier,
			eventBus: this.eventBus,
		});
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
		const credentials = new EncryptedCredentialStore(getAuthPath());
		this.credentialStore = credentials;
		this.modelRuntime = await ModelRuntime.create({
			credentials,
			modelsPath: getModelsPath(),
			allowModelNetwork: true,
		});
		this.modelRegistry = new ModelRegistry(this.modelRuntime);

		this.customProviders = new CustomProvidersStore(this.modelRuntime, getCustomProvidersPath());
		this.customProviders.load();

		this.autoTitleService = new AutoTitleService({
			modelRuntime: this.modelRuntime,
			getUserSettings: () => this.userSettings!.getAll(),
		});
	}

	// ── Phase 3: Extensions (runtimeFactory + extension factories) ──
	//
	// IMPORTANT: Closures below capture `this` and reference planService /
	// sessionSubagentService via `this.xxx!`. These fields are null NOW but
	// will be set in buildCore() (Phase 4) BEFORE any closure is invoked.
	// The closures are stored in runtimeFactory and only called during
	// session creation, which happens after all phases complete.

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
		const modelRuntime = this.modelRuntime!;

		this.runtimeFactory = new SessionRuntimeFactory({
			agentDir: getLookDir(),
			modelRuntime,
			findProjectIdByCwd: (cwd) => this.findProjectIdByCwd(cwd),
			resolveProjectTrust: (cwd) => this.projectService!.resolveProjectTrust(cwd),
			buildExtensionFactories: async (cwd, sessionId, projectId) => {
				const resolvedProjectId = projectId ?? this.runtimeRegistry.get(sessionId)?.projectId ?? "";
				const permissionHandler = this.permissionService!.createToolCallHandler(cwd);
				return [
					createPermissionExtensionFactory(permissionHandler),
					createPlanExtensionFactory(sessionId, {
						getMode: (id) => this.permissionService!.getMode(id),
						askQuestions: (id, questions, signal) => this.planService!.requestQuestions(id, questions, signal),
						submitPlan: (id, plan, signal) => this.planService!.requestApproval(id, plan, signal),
					}),
					createModelListExtensionFactory(async () => getAvailableModels(this.modelRegistry!)),
					await createSubagentExtensionFactory(
						sessionId,
						{
							discoverAgents: async (_projectId, scope) => {
								const result = await discoverAgents(resolvedProjectId, scope);
								const enabled = this.userSettings!.getAll().enabledAgentDefinitions;
								if (enabled !== null)
									result.agents = result.agents.filter((agent) => enabled.includes(agent.name));
								return result;
							},
							runSubSession: (
								parentId: string,
								agent: AgentConfig,
								task: string,
								signal: AbortSignal | undefined,
								title: string,
								toolCallId: string,
								taskTitle: string,
								onUpdate?: (progress: SubagentProgress) => void,
							) =>
								this.sessionSubagentService!.runSubSession(
									parentId,
									agent,
									task,
									signal,
									title,
									toolCallId,
									taskTitle,
									onUpdate,
								),
							isSubagentEnabled: (id) => this.sessionSubagentService!.isEnabled(id),
						},
						resolvedProjectId,
					),
					createMcpExtensionFactory(sessionId, this.mcpManager!, cwd, resolvedProjectId, (cwd) =>
						this.projectService!.resolveProjectTrust(cwd),
					),
					createSkillInjectExtensionFactory(),
					createComputerUseExtensionFactory(this.computerUseService!),
				];
			},
		});
	}

	// ── Phase 4: Core services (plan, agentDef, subagent, lifecycle) ──
	// Circular deps are resolved via closures on `this`.

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
		const host = this.host!;
		const modelRegistry = this.modelRegistry!;

		// planService — created first; sessionPermissionOrchestrator is forward-referenced via closure
		this.planService = new PlanService(host, host, this.permissionService!, async (sessionId) => {
			await this.sessionPermissionOrchestrator!.applyMode(sessionId, "always", {
				internal: true,
				updateDefault: false,
			});
		});

		// agentDefinitionService — sessionSubagentService forward-referenced via closure
		this.agentDefinitionService = new AgentDefinitionService(() =>
			this.sessionSubagentService!.reloadAllSessionsForAgents(),
		);

		// sessionSubagentService — runtimeLifecycle forward-referenced via closures in host
		this.sessionSubagentService = new SessionSubagentService({
			host: {
				createManagedRuntime: (cwd, manager, projectId, createdAt, startEvent, options) =>
					this.runtimeLifecycle!.createManagedRuntime(cwd, manager, projectId, createdAt, startEvent, options),
				getManagedRuntime: (sessionId) => this.runtimeRegistry.get(sessionId),
				reloadSession: async (sessionId) => {
					const managed = this.runtimeRegistry.get(sessionId);
					if (managed) await managed.runtime.session.reload();
				},
				listRuntimeIds: () => this.runtimeRegistry.keys(),
				getProjectInfo: (projectId) => this.projectService!.getProjectInfo(projectId),
				emit: (event) => host.emit(event),
				emitSessionUpdated: (sessionId) => host.emitSessionUpdated(sessionId),
				getScope: (sessionId) => this.scopeRegistry.get(sessionId),
				acquireScope: (sessionId, projectId) => this.scopeRegistry.acquire(sessionId, projectId),
				runtimeInfo: (sessionId) => this.sessionInfoService!.getAgentInfo(sessionId),
			},
			modelRegistry,
			subAgentRegistry: this.subAgentRegistry,
			subAgentRuntimeService: this.subAgentRuntimeService!,
			permissionService: this.permissionService!,
			planService: this.planService,
			userSettings: this.userSettings!,
			agentDefinitionService: this.agentDefinitionService,
			maxSubagentDepth: MAX_SUBAGENT_DEPTH,
			maxNameLength: MAX_NAME_LENGTH,
		});
		this.sessionSubagentService.loadDefaultFromSettings();

		// runtimeLifecycle — references sessionSubagentService (already assigned)
		this.runtimeLifecycle = new RuntimeLifecycleCoordinator({
			runtimeFactory: this.runtimeFactory!,
			runtimeRegistry: this.runtimeRegistry,
			scopeRegistry: this.scopeRegistry,
			permissionService: this.permissionService!,
			planService: this.planService,
			subAgentRegistry: this.subAgentRegistry,
			subAgentRuntimeService: this.subAgentRuntimeService!,
			autoTitleService: this.autoTitleService!,
			eventProcessor: this.eventProcessor!,
			sessionSubagentService: this.sessionSubagentService,
			sessionNotifier: this.sessionNotifier!,
			selection: this.activeSessionSelection,
			getStoredSession: (sessionId) => this.sessionCatalog!.get(sessionId),
			openSessionManager: (stored) => SessionManager.open(stored.path),
			handleSessionEvent: (sessionId, event) => this.eventProcessor!.handle(sessionId, event),
			setActiveProjectId: (projectId) => this.projectService!.setActiveId(projectId),
			refreshProjectSessions: (projectId) => this.refreshProjectSessions(projectId),
			events: {
				emit: (event) => host.emit(event),
				emitSessionState: (sessionId, reason) => host.emitSessionState(sessionId, reason ?? "activate"),
				emitProjectList: () => this.sessionNotifier!.emitProjectList(),
			},
		});
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
		const host = this.host!;
		const modelRegistry = this.modelRegistry!;

		this.sessionHistoryService = new SessionHistoryService({
			ensureRuntime: (sessionId) => this.runtimeLifecycle!.ensureRuntime(sessionId),
			createManagedRuntime: (cwd, manager, projectId, createdAt, startEvent) =>
				this.runtimeLifecycle!.createManagedRuntime(cwd, manager, projectId, createdAt, startEvent),
			withSessionLock: (sessionId, task) => this.runtimeRegistry.withExclusive(sessionId, task),
			disposeRuntime: (sessionId, abort) => this.runtimeLifecycle!.disposeRuntime(sessionId, abort),
			getRuntime: (sessionId) => host.getRuntime(sessionId),
			getSessionManager: (sessionId) => this.sessionManagerFor(sessionId),
			refreshProjectSessions: (projectId) => this.refreshProjectSessions(projectId),
			activateForkedSession: (projectId, sessionId) => {
				this.projectService!.setActiveId(projectId);
				this.activeSessionSelection.setCurrent(sessionId);
			},
			markSessionDefaultName: (sessionId) => {
				const scope = this.scopeRegistry.get(sessionId);
				if (scope) scope.isDefaultName = true;
			},
			emitSessionState: (sessionId, reason) => host.emitSessionState(sessionId, reason),
		});

		this.sessionControlService = new SessionControlService(
			{
				ensureRuntime: (sessionId) => this.runtimeLifecycle!.ensureRuntime(sessionId),
				getManagedRuntime: (sessionId) => this.runtimeRegistry.get(sessionId),
				getSessionManager: (sessionId) => this.sessionManagerFor(sessionId),
				updateStoredName: (sessionId, name) => {
					const stored = this.sessionCatalog!.get(sessionId);
					if (stored) stored.name = name;
					return stored;
				},
				closeDefaultNameGate: (sessionId) => {
					const scope = this.scopeRegistry.get(sessionId);
					if (scope) scope.isDefaultName = false;
				},
				emitSessionUpdated: (sessionId) => host.emitSessionUpdated(sessionId),
				emitSessionList: (projectId) => this.sessionNotifier!.emitSessionList(projectId),
				emitSessionState: (sessionId, reason) => host.emitSessionState(sessionId, reason ?? "activate"),
			},
			modelRegistry,
			this.scopeRegistry,
			MAX_NAME_LENGTH,
		);

		this.sessionLifecycleService = new SessionLifecycleService({
			host: {
				createManagedRuntime: (cwd, manager, projectId, createdAt, startEvent, options) =>
					this.runtimeLifecycle!.createManagedRuntime(cwd, manager, projectId, createdAt, startEvent, options),
				disposeRuntime: (sessionId, abort) => this.runtimeLifecycle!.disposeRuntime(sessionId, abort),
				refreshProjectSessions: (projectId) => this.refreshProjectSessions(projectId),
				getStoredSession: (sessionId) => this.sessionCatalog!.get(sessionId),
				emit: (event) => host.emit(event),
				emitSessionState: (sessionId, reason) => host.emitSessionState(sessionId, reason ?? "activate"),
				emitSessionList: (projectId) => this.sessionNotifier!.emitSessionList(projectId),
				setActiveProjectId: (projectId) => this.projectService!.setActiveId(projectId),
				setActiveSessionId: (sessionId) => this.activeSessionSelection.setCurrent(sessionId),
				getActiveSessionId: () => this.activeSessionSelection.currentId,
			},
			projectService: this.projectService!,
			runtimeRegistry: this.runtimeRegistry,
			scopeRegistry: this.scopeRegistry,
			subAgentRuntimeService: this.subAgentRuntimeService!,
			sessionInfoService: this.sessionInfoService!,
			permissionService: this.permissionService!,
			planService: this.planService!,
			userSettings: this.userSettings!,
			modelRegistry,
			getAvailableModelsSync: () => getAvailableModels(modelRegistry),
		});

		this.projectDeletionService = new ProjectDeletionService({
			projectService: this.projectService!,
			sessionCatalog: this.sessionCatalog!,
			runtimeRegistry: this.runtimeRegistry,
			disposeRuntime: (sessionId, abort) => this.runtimeLifecycle!.disposeRuntime(sessionId, abort),
			workspaceFileService: this.workspaceFileServiceRef,
			workspaceTreeService: this.workspaceTreeServiceRef,
			emitSessionList: (projectId) => this.sessionNotifier!.emitSessionList(projectId),
			emitProjectList: () => this.sessionNotifier!.emitProjectList(),
			getActiveSessionId: () => this.activeSessionSelection.currentId,
			setActiveSessionId: (sessionId) => this.activeSessionSelection.setCurrent(sessionId),
			deleteScheduledTasksByProject: async (projectId) => this.schedulerRef.current?.deleteTasksByProject(projectId),
		});

		this.sessionMessagingService = new SessionMessagingService({
			ensureRuntime: (sessionId) => this.runtimeLifecycle!.ensureRuntime(sessionId),
			emitError: (error, sessionId) => this.sessionNotifier!.emitError(error, sessionId),
		});

		this.sessionPermissionOrchestrator = new SessionPermissionOrchestrator({
			host: { ensureRuntime: (sessionId) => this.runtimeLifecycle!.ensureRuntime(sessionId) },
			eventBus: this.eventBus!,
			permissionService: this.permissionService!,
			planService: this.planService!,
			userSettings: this.userSettings!,
			modelRegistry: this.modelRegistry!,
		});

		this.sessionEventEffects = new SessionEventEffects({
			runtimeRegistry: this.runtimeRegistry,
			scopeRegistry: this.scopeRegistry,
			permissionService: this.permissionService!,
			planService: this.planService!,
			subAgentRuntimeService: this.subAgentRuntimeService!,
			subAgentRegistry: this.subAgentRegistry,
			autoTitleService: this.autoTitleService!,
			emitUsageUpdated: () => host.emit({ type: "usage:updated" }),
			getStoredProjectId: (sessionId) => this.sessionCatalog!.get(sessionId)?.projectId,
			refreshProjectSessions: (projectId) => this.refreshProjectSessions(projectId),
			emitSessionUpdated: (sessionId) => host.emitSessionUpdated(sessionId),
			emitSessionList: (projectId) => this.sessionNotifier!.emitSessionList(projectId),
			emitError: (error, sessionId) => this.sessionNotifier!.emitError(error, sessionId),
		});
		host.bindRuntimeServices({
			runtimeLifecycle: this.runtimeLifecycle!,
			sessionNotifier: this.sessionNotifier!,
			sessionEventEffects: this.sessionEventEffects,
			subAgentRuntimeService: this.subAgentRuntimeService!,
		});

		this.sessionSettingsService = new SessionSettingsService({
			userSettings: this.userSettings!,
			listProjects: () => this.projectService!.listProjects(),
			getActiveProject: () => this.projectService!.getActiveProject(),
			listSessionIds: () => this.sessionInfoService!.listAgents().map((agent) => agent.id),
			listRuntimes: () => this.runtimeRegistry.values(),
			listRuntimeIds: () => this.runtimeRegistry.keys(),
			permissionService: this.permissionService!,
			sessionSubagentService: this.sessionSubagentService!,
			projectTrustDefaults: this.globalSettingsManager!,
		});

		this.skillManagementService = new SkillManagementService({
			runtimeRegistry: this.runtimeRegistry,
			selection: this.activeSessionSelection,
			globalSettingsManager: this.globalSettingsManager!,
			userSettings: this.userSettings!,
		});
	}

	// ── Validate ──

	/**
	 * Validate and freeze into an immutable RuntimeManagerComposition.
	 *
	 * Checks that all required service fields are non-null. If any phase was
	 * skipped or failed, this throws a descriptive error identifying the
	 * missing field.
	 *
	 * Returns: this (for chaining with build() method)
	 */
	validate(): this {
		const required: Record<string, unknown> = {
			trustStore: this.trustStore,
			globalSettingsManager: this.globalSettingsManager,
			projectService: this.projectService,
			userSettings: this.userSettings,
			permissionService: this.permissionService,
			promptStore: this.promptStore,
			mcpManager: this.mcpManager,
			sessionCatalog: this.sessionCatalog,
			projectRuntimeService: this.projectRuntimeService,
			sessionInfoService: this.sessionInfoService,
			sessionNotifier: this.sessionNotifier,
			eventProcessor: this.eventProcessor,
			subAgentRuntimeService: this.subAgentRuntimeService,
			projectApplicationService: this.projectApplicationService,
			modelRuntime: this.modelRuntime,
			modelRegistry: this.modelRegistry,
			credentialStore: this.credentialStore,
			customProviders: this.customProviders,
			autoTitleService: this.autoTitleService,
			runtimeFactory: this.runtimeFactory,
			planService: this.planService,
			agentDefinitionService: this.agentDefinitionService,
			sessionSubagentService: this.sessionSubagentService,
			runtimeLifecycle: this.runtimeLifecycle,
			sessionHistoryService: this.sessionHistoryService,
			sessionControlService: this.sessionControlService,
			sessionLifecycleService: this.sessionLifecycleService,
			projectDeletionService: this.projectDeletionService,
			sessionMessagingService: this.sessionMessagingService,
			sessionPermissionOrchestrator: this.sessionPermissionOrchestrator,
			sessionEventEffects: this.sessionEventEffects,
			sessionSettingsService: this.sessionSettingsService,
			skillManagementService: this.skillManagementService,
		};

		const missing = Object.entries(required)
			.filter(([, v]) => v === null)
			.map(([k]) => k);

		if (missing.length > 0) {
			throw new Error(`[Look] CompositionBuilder validation failed: missing services: ${missing.join(", ")}`);
		}

		return this;
	}

	/** Accessors for RuntimeManagerComposition constructor. */
	getWorkspaceFileService(): WorkspaceFileService | null {
		return this.workspaceFileServiceRef;
	}
	getWorkspaceTreeService(): WorkspaceTreeService | null {
		return this.workspaceTreeServiceRef;
	}

	// ── Helpers (shared across phases) ──

	private findProjectIdByCwd(cwd: string): string | undefined {
		return this.projectService!.listProjects().find((project) => project.cwd === cwd)?.id;
	}

	private refreshProjectSessions(projectId: string) {
		const project = this.projectService!.getProjectInfo(projectId);
		return project?.valid ? this.sessionCatalog!.refresh(project) : Promise.resolve([]);
	}

	private sessionManagerFor(sessionId: string): SessionManager | undefined {
		const managed = this.runtimeRegistry.get(sessionId);
		if (managed) return managed.binding.sessionManager;
		const stored = this.sessionCatalog!.get(sessionId);
		return stored && existsSync(stored.path) ? SessionManager.open(stored.path) : undefined;
	}
}
