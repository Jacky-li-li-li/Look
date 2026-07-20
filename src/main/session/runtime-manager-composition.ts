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
import type { ProjectInfo } from "@look/shared/types";
import { AgentDefinitionService } from "../agents/definition-service.js";
import type { IRuntimeLifecycle } from "../core/contracts.js";
import { createMcpExtensionFactory } from "../extensions/mcp-extension.js";
import { createModelListExtensionFactory } from "../extensions/model-extension.js";
import { createPermissionExtensionFactory } from "../extensions/permission-extension.js";
import { createPlanExtensionFactory } from "../extensions/plan-extension.js";
import { discoverAgents } from "../extensions/subagent/agent-discovery.js";
import { createSubagentExtensionFactory } from "../extensions/subagent/subagent-extension.js";
import { MCPManager } from "../mcp/manager.js";
import { getAvailableModels } from "../models/model-queries.js";
import { PlanService } from "../permissions/plan.js";
import { PermissionService } from "../permissions/service.js";
import { ProjectDeletionService } from "../projects/project-deletion-service.js";
import { ProjectService } from "../projects/project-service.js";
import type { SchedulerService } from "../scheduler/scheduler-service.js";
import { EncryptedCredentialStore } from "../security/secrets.js";
import { AutoTitleService } from "../services/auto-title.js";
import { SubAgentRuntimeService } from "../services/subagent-runtime.js";
import { CustomProvidersStore } from "../settings/custom-providers.js";
import { migrateLegacySettings } from "../settings/migrate.js";
import { PromptStore } from "../settings/prompt-store.js";
import { UserSettingsStore } from "../settings/store.js";
import type { WorkspaceFileService } from "../workspace/workspace-file-service.js";
import type { WorkspaceTreeService } from "../workspace/workspace-tree-service.js";
import { ActiveSessionSelection } from "./active-session-selection.js";
import { type ISessionEventHost, SessionEventProcessor } from "./event-processor.js";
import { ProjectRuntimeService } from "./project-runtime-service.js";
import { SessionRuntimeFactory } from "./runtime-factory.js";
import { RuntimeLifecycleCoordinator } from "./runtime-lifecycle-coordinator.js";
import { RuntimeRegistry } from "./runtime-registry.js";
import { SessionScopeRegistry } from "./scope-registry.js";
import { SessionCatalog } from "./session-catalog.js";
import { SessionControlService } from "./session-control-service.js";
import { SessionEventBus } from "./session-event-bus.js";
import { SessionEventEffects } from "./session-event-effects.js";
import { SessionHistoryService } from "./session-history-service.js";
import { SessionInfoService } from "./session-info-service.js";
import { SessionLifecycleService } from "./session-lifecycle-service.js";
import { SessionMessagingService } from "./session-messaging-service.js";
import { SessionNotifier } from "./session-notifier.js";
import { SessionPermissionOrchestrator } from "./session-permission-orchestrator.js";
import { SessionSettingsService } from "./session-settings-service.js";
import { SessionSubagentService } from "./session-subagent-service.js";
import { SkillManagementService } from "./skill-management-service.js";
import { SubAgentRegistry } from "./subagent-registry.js";
import { UsageTrackingService } from "./usage-tracking-service.js";

const MAX_NAME_LENGTH = 80;
const MAX_SUBAGENT_DEPTH = 5;

export interface RuntimeManagerCompositionHost extends IRuntimeLifecycle, ISessionEventHost {
	listProjects(): ProjectInfo[];
}

/** The process composition root for SessionRuntimeManager's domain services. */
export class RuntimeManagerComposition {
	readonly eventBus = new SessionEventBus();
	readonly modelRuntime!: ModelRuntime;
	readonly modelRegistry!: ModelRegistry;
	readonly credentialStore!: EncryptedCredentialStore;
	readonly customProviders!: CustomProvidersStore;
	readonly trustStore: ProjectTrustStore;
	readonly globalSettingsManager: SettingsManager;
	readonly projectService: ProjectService;
	readonly userSettings: UserSettingsStore;
	readonly permissionService: PermissionService;
	readonly autoTitleService!: AutoTitleService;
	readonly promptStore: PromptStore;
	readonly planService!: PlanService;
	readonly mcpManager: MCPManager;
	readonly runtimeFactory!: SessionRuntimeFactory;
	readonly sessionCatalog: SessionCatalog;
	readonly runtimeRegistry = new RuntimeRegistry();
	readonly scopeRegistry = new SessionScopeRegistry();
	readonly subAgentRegistry = new SubAgentRegistry();
	readonly activeSessionSelection = new ActiveSessionSelection();
	readonly projectRuntimeService: ProjectRuntimeService;
	readonly sessionInfoService: SessionInfoService;
	readonly sessionNotifier: SessionNotifier;
	readonly sessionHistoryService!: SessionHistoryService;
	readonly sessionControlService!: SessionControlService;
	readonly projectDeletionService!: ProjectDeletionService;
	readonly eventProcessor: SessionEventProcessor;
	readonly subAgentRuntimeService: SubAgentRuntimeService;
	readonly agentDefinitionService!: AgentDefinitionService;
	readonly sessionSubagentService!: SessionSubagentService;
	readonly sessionLifecycleService!: SessionLifecycleService;
	readonly sessionMessagingService!: SessionMessagingService;
	readonly sessionPermissionOrchestrator!: SessionPermissionOrchestrator;
	readonly runtimeLifecycle!: RuntimeLifecycleCoordinator;
	readonly sessionEventEffects!: SessionEventEffects;
	readonly sessionSettingsService!: SessionSettingsService;
	readonly skillManagementService!: SkillManagementService;
	private readonly host: RuntimeManagerCompositionHost;
	private schedulerService?: SchedulerService;

	constructor(
		host: RuntimeManagerCompositionHost,
		readonly workspaceFileService: WorkspaceFileService | null,
		readonly workspaceTreeService: WorkspaceTreeService | null,
	) {
		this.host = host;
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
		this.permissionService = new PermissionService(host, this.userSettings.getAll().permissionMode);
		this.globalSettingsManager.setDefaultProjectTrust("ask");
		this.promptStore = new PromptStore();

		// All services that depend on modelRuntime/modelRegistry are created
		// in initAsync(). Fields are !-asserted and assigned there.
		//
		// Services that don't depend on modelRuntime: created eagerly here.
		this.mcpManager = new MCPManager();
		this.mcpManager.setOnChange(() => host.emit({ type: "mcp:status-changed" }));

		this.sessionCatalog = new SessionCatalog((metadata) => {
			if (metadata.parentSessionId) {
				this.subAgentRegistry.register(metadata.parentSessionId, metadata.sessionId, metadata.agentName ?? "");
			}
		});
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
			listProjects: () => host.listProjects(),
			getActiveProjectId: () => this.projectService.activeId,
		});

		this.eventProcessor = new SessionEventProcessor(host, this.scopeRegistry, host);
		this.subAgentRuntimeService = new SubAgentRuntimeService(host, this.subAgentRegistry);
	}

	/** Initialize all async-dependent and modelRegistry-dependent services. */
	async initAsync(): Promise<void> {
		const host = this.host;
		const self = this as {
			modelRuntime: ModelRuntime;
			modelRegistry: ModelRegistry;
			credentialStore: EncryptedCredentialStore;
			customProviders: CustomProvidersStore;
			autoTitleService: AutoTitleService;
			runtimeFactory: SessionRuntimeFactory;
			sessionSubagentService: SessionSubagentService;
			runtimeLifecycle: RuntimeLifecycleCoordinator;
			sessionHistoryService: SessionHistoryService;
			sessionControlService: SessionControlService;
			sessionLifecycleService: SessionLifecycleService;
			sessionEventEffects: SessionEventEffects;
			sessionSettingsService: SessionSettingsService;
			agentDefinitionService: AgentDefinitionService;
			planService: PlanService;
			projectDeletionService: ProjectDeletionService;
			sessionMessagingService: SessionMessagingService;
			sessionPermissionOrchestrator: SessionPermissionOrchestrator;
			skillManagementService: SkillManagementService;
		};

		const credentials = new EncryptedCredentialStore(getAuthPath());
		self.credentialStore = credentials;
		self.modelRuntime = await ModelRuntime.create({
			credentials,
			modelsPath: getModelsPath(),
		});
		self.modelRegistry = new ModelRegistry(self.modelRuntime);

		self.customProviders = new CustomProvidersStore(self.modelRuntime, getCustomProvidersPath());
		self.customProviders.load();

		self.autoTitleService = new AutoTitleService({
			modelRegistry: self.modelRegistry,
			getUserSettings: () => this.userSettings.getAll(),
		});

		self.runtimeFactory = new SessionRuntimeFactory({
			agentDir: getLookDir(),
			modelRuntime: self.modelRuntime,
			findProjectIdByCwd: (cwd) => this.findProjectIdByCwd(cwd),
			resolveProjectTrust: (cwd) => this.projectService.resolveProjectTrust(cwd),
			buildExtensionFactories: async (cwd, sessionId, projectId) => {
				const resolvedProjectId = projectId ?? this.runtimeRegistry.get(sessionId)?.projectId ?? "";
				const permissionHandler = this.permissionService.createToolCallHandler(cwd);
				return [
					createPermissionExtensionFactory(permissionHandler),
					createPlanExtensionFactory(sessionId, {
						getMode: (id) => this.permissionService.getMode(id),
						askQuestions: (id, questions, signal) => this.planService.requestQuestions(id, questions, signal),
						submitPlan: (id, plan, signal) => this.planService.requestApproval(id, plan, signal),
					}),
					createModelListExtensionFactory(async () => getAvailableModels(this.modelRegistry)),
					await createSubagentExtensionFactory(
						sessionId,
						{
							discoverAgents: async (_projectId, scope) => {
								const result = await discoverAgents(resolvedProjectId, scope);
								const enabled = this.userSettings.getAll().enabledAgentDefinitions;
								if (enabled !== null)
									result.agents = result.agents.filter((agent) => enabled.includes(agent.name));
								return result;
							},
							runSubSession: (parentId, agent, task, signal, onUpdate, title) =>
								this.sessionSubagentService.runSubSession(parentId, agent, task, signal, onUpdate, title),
							isSubagentEnabled: (id) => this.sessionSubagentService.isEnabled(id),
						},
						resolvedProjectId,
					),
					createMcpExtensionFactory(sessionId, this.mcpManager, cwd, resolvedProjectId),
				];
			},
		});

		// Create planService first — sessionSubagentService depends on it
		self.planService = new PlanService(host, host, this.permissionService, async (sessionId) => {
			await this.sessionPermissionOrchestrator.applyMode(sessionId, "always", {
				internal: true,
				updateDefault: false,
			});
		});

		self.sessionSubagentService = new SessionSubagentService({
			host: {
				createManagedRuntime: (cwd, manager, projectId, createdAt, startEvent, options) =>
					this.runtimeLifecycle.createManagedRuntime(cwd, manager, projectId, createdAt, startEvent, options),
				getManagedRuntime: (sessionId) => this.runtimeRegistry.get(sessionId),
				reloadSession: async (sessionId) => {
					const managed = this.runtimeRegistry.get(sessionId);
					if (managed) await managed.runtime.session.reload();
				},
				listRuntimeIds: () => this.runtimeRegistry.keys(),
				getProjectInfo: (projectId) => this.projectService.getProjectInfo(projectId),
				emit: (event) => host.emit(event),
				emitSessionUpdated: (sessionId) => host.emitSessionUpdated(sessionId),
				getScope: (sessionId) => this.scopeRegistry.get(sessionId),
				acquireScope: (sessionId, projectId) => this.scopeRegistry.acquire(sessionId, projectId),
				runtimeInfo: (sessionId) => this.sessionInfoService.getAgentInfo(sessionId),
			},
			modelRegistry: self.modelRegistry,
			subAgentRegistry: this.subAgentRegistry,
			subAgentRuntimeService: this.subAgentRuntimeService,
			permissionService: this.permissionService,
			planService: this.planService,
			userSettings: this.userSettings,
			agentDefinitionService: this.agentDefinitionService,
			maxSubagentDepth: MAX_SUBAGENT_DEPTH,
			maxNameLength: MAX_NAME_LENGTH,
		});
		this.sessionSubagentService.loadDefaultFromSettings();

		self.runtimeLifecycle = new RuntimeLifecycleCoordinator({
			runtimeFactory: self.runtimeFactory,
			runtimeRegistry: this.runtimeRegistry,
			scopeRegistry: this.scopeRegistry,
			permissionService: this.permissionService,
			planService: this.planService,
			subAgentRegistry: this.subAgentRegistry,
			subAgentRuntimeService: this.subAgentRuntimeService,
			autoTitleService: this.autoTitleService,
			eventProcessor: this.eventProcessor,
			sessionSubagentService: this.sessionSubagentService,
			sessionNotifier: this.sessionNotifier,
			selection: this.activeSessionSelection,
			getStoredSession: (sessionId) => this.sessionCatalog.get(sessionId),
			openSessionManager: (stored) => SessionManager.open(stored.path),
			handleSessionEvent: (sessionId, event) => this.eventProcessor.handle(sessionId, event),
			setActiveProjectId: (projectId) => this.projectService.setActiveId(projectId),
			refreshProjectSessions: (projectId) => this.refreshProjectSessions(projectId),
			events: {
				emit: (event) => host.emit(event),
				emitSessionState: (sessionId, reason) => host.emitSessionState(sessionId, reason ?? "activate"),
				emitProjectList: () => this.sessionNotifier.emitProjectList(),
			},
		});

		self.sessionHistoryService = new SessionHistoryService({
			ensureRuntime: (sessionId) => this.runtimeLifecycle.ensureRuntime(sessionId),
			createManagedRuntime: (cwd, manager, projectId, createdAt, startEvent) =>
				this.runtimeLifecycle.createManagedRuntime(cwd, manager, projectId, createdAt, startEvent),
			withSessionLock: (sessionId, task) => this.runtimeRegistry.withExclusive(sessionId, task),
			disposeRuntime: (sessionId, abort) => this.runtimeLifecycle.disposeRuntime(sessionId, abort),
			getRuntime: (sessionId) => host.getRuntime(sessionId),
			getSessionManager: (sessionId) => this.sessionManagerFor(sessionId),
			refreshProjectSessions: (projectId) => this.refreshProjectSessions(projectId),
			activateForkedSession: (projectId, sessionId) => {
				this.projectService.setActiveId(projectId);
				this.activeSessionSelection.setCurrent(sessionId);
			},
			markSessionDefaultName: (sessionId) => {
				const scope = this.scopeRegistry.get(sessionId);
				if (scope) scope.isDefaultName = true;
			},
			emitSessionState: (sessionId, reason) => host.emitSessionState(sessionId, reason),
		});
		self.sessionControlService = new SessionControlService(
			{
				ensureRuntime: (sessionId) => this.runtimeLifecycle.ensureRuntime(sessionId),
				getManagedRuntime: (sessionId) => this.runtimeRegistry.get(sessionId),
				getSessionManager: (sessionId) => this.sessionManagerFor(sessionId),
				updateStoredName: (sessionId, name) => {
					const stored = this.sessionCatalog.get(sessionId);
					if (stored) stored.name = name;
					return stored;
				},
				closeDefaultNameGate: (sessionId) => {
					const scope = this.scopeRegistry.get(sessionId);
					if (scope) scope.isDefaultName = false;
				},
				emitSessionUpdated: (sessionId) => host.emitSessionUpdated(sessionId),
				emitSessionList: (projectId) => this.sessionNotifier.emitSessionList(projectId),
			},
			self.modelRegistry,
			MAX_NAME_LENGTH,
		);

		self.sessionLifecycleService = new SessionLifecycleService({
			host: {
				createManagedRuntime: (cwd, manager, projectId, createdAt, startEvent, options) =>
					this.runtimeLifecycle.createManagedRuntime(cwd, manager, projectId, createdAt, startEvent, options),
				disposeRuntime: (sessionId, abort) => this.runtimeLifecycle.disposeRuntime(sessionId, abort),
				refreshProjectSessions: (projectId) => this.refreshProjectSessions(projectId),
				getStoredSession: (sessionId) => this.sessionCatalog.get(sessionId),
				emit: (event) => host.emit(event),
				emitSessionState: (sessionId, reason) => host.emitSessionState(sessionId, reason ?? "activate"),
				emitSessionList: (projectId) => this.sessionNotifier.emitSessionList(projectId),
				setActiveProjectId: (projectId) => this.projectService.setActiveId(projectId),
				setActiveSessionId: (sessionId) => this.activeSessionSelection.setCurrent(sessionId),
				getActiveSessionId: () => this.activeSessionSelection.currentId,
			},
			projectService: this.projectService,
			runtimeRegistry: this.runtimeRegistry,
			scopeRegistry: this.scopeRegistry,
			subAgentRuntimeService: this.subAgentRuntimeService,
			sessionInfoService: this.sessionInfoService,
			permissionService: this.permissionService,
			planService: this.planService,
			userSettings: this.userSettings,
			modelRegistry: self.modelRegistry,
			getAvailableModelsSync: () => getAvailableModels(self.modelRegistry),
		});

		self.agentDefinitionService = new AgentDefinitionService(() =>
			this.sessionSubagentService.reloadAllSessionsForAgents(),
		);

		self.projectDeletionService = new ProjectDeletionService({
			projectService: this.projectService,
			sessionCatalog: this.sessionCatalog,
			runtimeRegistry: this.runtimeRegistry,
			disposeRuntime: (sessionId, abort) => this.runtimeLifecycle.disposeRuntime(sessionId, abort),
			workspaceFileService: this.workspaceFileService,
			workspaceTreeService: this.workspaceTreeService,
			emitSessionList: (projectId) => this.sessionNotifier.emitSessionList(projectId),
			emitProjectList: () => this.sessionNotifier.emitProjectList(),
			getActiveSessionId: () => this.activeSessionSelection.currentId,
			setActiveSessionId: (sessionId) => this.activeSessionSelection.setCurrent(sessionId),
			deleteScheduledTasksByProject: async (projectId) => this.schedulerService?.deleteTasksByProject(projectId),
		});

		self.sessionMessagingService = new SessionMessagingService({
			ensureRuntime: (sessionId) => this.runtimeLifecycle.ensureRuntime(sessionId),
			emitError: (error, sessionId) => this.sessionNotifier.emitError(error, sessionId),
		});

		self.sessionPermissionOrchestrator = new SessionPermissionOrchestrator({
			host: { ensureRuntime: (sessionId) => this.runtimeLifecycle.ensureRuntime(sessionId) },
			permissionService: this.permissionService,
			planService: this.planService,
			userSettings: this.userSettings,
		});

		self.sessionEventEffects = new SessionEventEffects({
			runtimeRegistry: this.runtimeRegistry,
			scopeRegistry: this.scopeRegistry,
			permissionService: this.permissionService,
			planService: this.planService,
			subAgentRuntimeService: this.subAgentRuntimeService,
			subAgentRegistry: this.subAgentRegistry,
			autoTitleService: this.autoTitleService,
			usageTrackingService: new UsageTrackingService((event) => host.emit(event)),
			getStoredProjectId: (sessionId) => this.sessionCatalog.get(sessionId)?.projectId,
			refreshProjectSessions: (projectId) => this.refreshProjectSessions(projectId),
			emitSessionUpdated: (sessionId) => host.emitSessionUpdated(sessionId),
			emitSessionList: (projectId) => this.sessionNotifier.emitSessionList(projectId),
			emitError: (error, sessionId) => this.sessionNotifier.emitError(error, sessionId),
		});

		self.sessionSettingsService = new SessionSettingsService({
			userSettings: this.userSettings,
			listProjects: () => this.projectService.listProjects(),
			getActiveProject: () => this.projectService.getActiveProject(),
			listSessionIds: () => this.sessionInfoService.listAgents().map((agent) => agent.id),
			listRuntimes: () => this.runtimeRegistry.values(),
			listRuntimeIds: () => this.runtimeRegistry.keys(),
			permissionService: this.permissionService,
			sessionSubagentService: this.sessionSubagentService,
			projectTrustDefaults: this.globalSettingsManager,
		});

		self.skillManagementService = new SkillManagementService({
			runtimeRegistry: this.runtimeRegistry,
			selection: this.activeSessionSelection,
			globalSettingsManager: this.globalSettingsManager,
			userSettings: this.userSettings,
		});
	}

	setSchedulerService(schedulerService: SchedulerService): void {
		this.schedulerService = schedulerService;
	}

	private findProjectIdByCwd(cwd: string): string | undefined {
		return this.projectService.listProjects().find((project) => project.cwd === cwd)?.id;
	}

	private refreshProjectSessions(projectId: string) {
		const project = this.projectService.getProjectInfo(projectId);
		return project?.valid ? this.sessionCatalog.refresh(project) : Promise.resolve([]);
	}

	private sessionManagerFor(sessionId: string): SessionManager | undefined {
		const managed = this.runtimeRegistry.get(sessionId);
		if (managed) return managed.binding.sessionManager;
		const stored = this.sessionCatalog.get(sessionId);
		return stored && existsSync(stored.path) ? SessionManager.open(stored.path) : undefined;
	}
}
