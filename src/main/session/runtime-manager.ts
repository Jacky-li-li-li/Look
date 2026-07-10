import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	AuthStorage,
	type ExtensionFactory,
	ModelRegistry,
	ProjectTrustStore,
	SessionManager,
	type SessionStartEvent,
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
import { DEFAULT_SESSION_NAME } from "@look/shared/session-defaults";
import type {
	AgentDefinitionInfo,
	AgentDefinitionInput,
	AgentInfo,
	ForkedSessionResult,
	ImSessionProvider,
	MainToRendererEvent,
	NavigateTreeResult,
	PermissionMode,
	PermissionRespondPayload,
	PlanApprovalResponse,
	PlanQuestionResponse,
	ProjectInfo,
	SessionSnapshotEnvelope,
	ThinkingLevel,
} from "@look/shared/types";
import { AgentDefinitionService } from "../agents/definition-service.js";
import type { IEventBus, IPermissionService, IPlanService, IRuntimeLifecycle } from "../core/contracts.js";
import { createMcpExtensionFactory } from "../extensions/mcp-extension.js";
import { createModelListExtensionFactory } from "../extensions/model-extension.js";
import { createPermissionExtensionFactory } from "../extensions/permission-extension.js";
import { createPlanExtensionFactory } from "../extensions/plan-extension.js";
import { discoverAgents } from "../extensions/subagent/agent-discovery.js";
import { createSubagentExtensionFactory } from "../extensions/subagent/subagent-extension.js";
import type { AgentConfig, SubagentHost, SubagentProgress, SubagentResult } from "../extensions/subagent/types.js";
import { MCPManager } from "../mcp/manager.js";
import { ModelProviderService } from "../models/model-provider-service.js";
import { PlanService } from "../permissions/plan.js";
import { PermissionService } from "../permissions/service.js";
import { ProjectDeletionService } from "../projects/project-deletion-service.js";
import { ProjectService } from "../projects/project-service.js";
import { AutoTitleService } from "../services/auto-title.js";
import { SubAgentRuntimeService } from "../services/subagent-runtime.js";
import { persistTurnDuration } from "../services/turn-metrics.js";
import type { ISessionEventHost } from "../session/event-processor.js";
import { SessionEventProcessor } from "../session/event-processor.js";
import { SessionScopeRegistry } from "../session/scope-registry.js";
import { SubAgentRegistry } from "../session/subagent-registry.js";
import { CustomProvidersStore } from "../settings/custom-providers.js";
import { migrateLegacySettings } from "../settings/migrate.js";
import { PromptStore } from "../settings/prompt-store.js";
import { type UserSettings, UserSettingsStore } from "../settings/store.js";
import {
	detectCommonSkillPaths,
	discoverSkillsFromPaths,
	isBuiltinSkillPath,
} from "../skills/skill-discovery-service.js";
import { formatLocalDate, incrementTurn } from "../system/usage.js";
import type { WorkspaceFileService } from "../workspace/workspace-file-service.js";
import type { WorkspaceTreeService } from "../workspace/workspace-tree-service.js";
import { ProjectRuntimeService } from "./project-runtime-service.js";
import { SessionRuntimeFactory } from "./runtime-factory.js";
import { type ManagedRuntime, RuntimeRegistry } from "./runtime-registry.js";
import { SessionCatalog, type StoredSession } from "./session-catalog.js";
import { SessionControlService } from "./session-control-service.js";
import { SessionEventBus } from "./session-event-bus.js";
import { SessionHistoryService } from "./session-history-service.js";
import { SessionInfoService } from "./session-info-service.js";
import { SessionLifecycleService } from "./session-lifecycle-service.js";
import { SessionMessagingService } from "./session-messaging-service.js";
import { SessionNotifier } from "./session-notifier.js";
import { SessionPermissionOrchestrator } from "./session-permission-orchestrator.js";
import { SessionSubagentService } from "./session-subagent-service.js";

export type { EventCallback } from "@look/shared/types";

import type { EventCallback } from "@look/shared/types";

const MAX_NAME_LENGTH = 80;
/** 最大子会话递归深度：防止 LLM 无限嵌套调用 subagent 工具。 */
const MAX_SUBAGENT_DEPTH = 5;
/**
 * Hosts independent pi AgentSessionRuntime instances for sessions that are
 * selected or currently running. Each runtime still owns exactly one active pi
 * session; Look only supplies the cross-session registry and event routing.
 *
 * Implements IEventBus so domain services can depend on abstractions instead
 * of the concrete SRT class.
 */
export class SessionRuntimeManager implements IEventBus, IRuntimeLifecycle, ISessionEventHost {
	private readonly eventBus = new SessionEventBus();
	private readonly sessionCatalog: SessionCatalog;
	private readonly authStorage: AuthStorage;
	private readonly modelRegistry: ModelRegistry;
	private readonly customProvidersStore: CustomProvidersStore;
	private readonly modelProviderService: ModelProviderService;
	private readonly projectService: ProjectService;
	private readonly scopeRegistry = new SessionScopeRegistry();
	private readonly subAgentRegistry = new SubAgentRegistry();
	private readonly subAgentRuntimeService: SubAgentRuntimeService;
	private readonly eventProcessor: SessionEventProcessor;
	private readonly trustStore: ProjectTrustStore;
	private readonly globalSettingsManager: SettingsManager;
	private readonly userSettings: UserSettingsStore;
	// projectsIndexPath migrated to ProjectService
	private readonly runtimeRegistry = new RuntimeRegistry();
	private readonly runtimeFactory: SessionRuntimeFactory;
	private readonly sessionControlService: SessionControlService;
	private readonly sessionHistoryService: SessionHistoryService;
	private readonly sessionNotifier: SessionNotifier;
	private readonly sessionInfoService: SessionInfoService;
	private readonly projectDeletionService: ProjectDeletionService;
	private readonly sessionSubagentService: SessionSubagentService;
	private readonly sessionMessagingService: SessionMessagingService;
	private readonly sessionPermissionOrchestrator: SessionPermissionOrchestrator;
	private readonly projectRuntimeService: ProjectRuntimeService;
	private readonly sessionLifecycleService: SessionLifecycleService;
	// activeProjectId migrated to ProjectService
	private activeSessionId: string | null = null;
	private readonly workspaceFileService: WorkspaceFileService | null;
	private readonly workspaceTreeService: WorkspaceTreeService | null;
	private disposed = false;
	/** Per-runtime streaming state machine. 已迁移至 SessionScope。 */
	/** Runtime-local IM source for newly created sessions. 已迁移至 SessionScope。 */
	/** Turn start timestamp. 已迁移至 SessionScope。 */
	/** Auto-title gate. 已迁移至 SessionScope.isDefaultName。 */
	/** AI 标题生成服务。所有并发 / abort / generated-标记逻辑封装在这里，
	 *  SessionRuntimeManager 只负责传上下文和触发。 */
	private readonly autoTitleService: AutoTitleService;

	/** 自定义 System Prompt 管理器（多 prompt 变体 + SYSTEM.md 写入）。 */
	public readonly promptStore: PromptStore;

	/** MCP 服务器管理器 — 连接外部 MCP 服务器并桥接工具。 */
	public readonly mcpManager: MCPManager;

	/** Agent 定义文件 CRUD（~/.look/agents/*.md）。 */
	private readonly agentDefinitionService: AgentDefinitionService;

	/** 每 session 的工具调用权限门控（always/ask/plan）。 */
	private readonly permissionService: IPermissionService;

	/** Plan mode workflow management (questions, approval, tool restrictions). */
	private readonly planService: IPlanService;

	/** usage:updated 事件防抖定时器，合并高频 turn 完成事件。 */
	private usageUpdateTimer: ReturnType<typeof setTimeout> | null = null;

	/** Whether the session should be reported as streaming to the renderer.
	 *  Falls back to the SDK getter only when no event-derived state exists. */
	private isStreaming(sessionId: string, sdkValue: boolean): boolean {
		const scope = this.scopeRegistry.get(sessionId);
		if (scope) {
			if (scope.streamingState === "idle") return false;
			if (scope.streamingState === "streaming" || scope.streamingState === "retrying") return true;
		}
		return sdkValue;
	}

	constructor(workspaceFileService?: WorkspaceFileService, workspaceTreeService?: WorkspaceTreeService) {
		ensureLookDir();
		resetLegacySessionsOnce();
		const migration = migrateLegacySettings();
		if (migration.migrated && migration.keys.length > 0) {
			console.log(`[Look] Migrated settings: ${migration.keys.join(", ")}`);
		}
		this.authStorage = AuthStorage.create(getAuthPath());
		this.modelRegistry = ModelRegistry.create(this.authStorage, getModelsPath());
		this.customProvidersStore = new CustomProvidersStore(this.modelRegistry, getCustomProvidersPath());
		this.customProvidersStore.load();
		this.modelProviderService = new ModelProviderService(
			this.modelRegistry,
			this.authStorage,
			this.customProvidersStore,
		);
		this.trustStore = new ProjectTrustStore(getLookDir());
		this.globalSettingsManager = SettingsManager.create(getLookDir(), getLookDir());
		this.projectService = new ProjectService(this.trustStore, this.globalSettingsManager);
		this.userSettings = new UserSettingsStore(this.globalSettingsManager, getUiSettingsPath());
		this.permissionService = new PermissionService(this, this, this.userSettings.getAll().permissionMode);
		// Tool authorization must never silently grant trust to project resources.
		this.globalSettingsManager.setDefaultProjectTrust("ask");
		this.autoTitleService = new AutoTitleService({
			modelRegistry: this.modelRegistry,
			getUserSettings: () => this.userSettings.getAll(),
		});
		this.promptStore = new PromptStore();
		this.agentDefinitionService = new AgentDefinitionService(() =>
			this.sessionSubagentService.reloadAllSessionsForAgents(),
		);
		this.planService = new PlanService(this, this, this.permissionService, async (sessionId) => {
			await this.sessionPermissionOrchestrator.applyMode(sessionId, "always", {
				internal: true,
				updateDefault: false,
			});
		});
		// projectsIndexPath is managed by ProjectService internally
		this.mcpManager = new MCPManager();
		this.mcpManager.setOnChange(() => this.emit({ type: "mcp:status-changed" }));
		this.runtimeFactory = new SessionRuntimeFactory({
			agentDir: getLookDir(),
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
			findProjectIdByCwd: (cwd) => this.findProjectIdByCwd(cwd),
			resolveProjectTrust: (cwd) => this.resolveProjectTrust(cwd),
			buildExtensionFactories: (cwd, sessionId) => this.buildExtensionFactories(cwd, sessionId),
		});
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
			isStreaming: (sessionId, sdkValue) => this.isStreaming(sessionId, sdkValue),
			listProjects: () => this.listProjects(),
		});
		this.sessionNotifier = new SessionNotifier(this.eventBus, {
			sessionInfoService: this.sessionInfoService,
			listProjects: () => this.listProjects(),
			getActiveProjectId: () => this.projectService.activeId,
		});
		this.sessionHistoryService = new SessionHistoryService({
			ensureRuntime: (sessionId) => this.ensureRuntime(sessionId),
			createManagedRuntime: (cwd, sessionManager, projectId, createdAt, sessionStartEvent) =>
				this.createManagedRuntime(cwd, sessionManager, projectId, createdAt, sessionStartEvent),
			withSessionLock: (sessionId, task) => this.runtimeRegistry.withExclusive(sessionId, task),
			disposeRuntime: (sessionId, abort) => this.disposeRuntime(sessionId, abort),
			getRuntime: (sessionId) => this.getRuntime(sessionId),
			getSessionManager: (sessionId) => this.sessionManagerFor(sessionId) ?? undefined,
			refreshProjectSessions: (projectId) => this.refreshProjectSessions(projectId),
			activateForkedSession: (projectId, sessionId) => {
				this.projectService.setActiveId(projectId);
				this.activeSessionId = sessionId;
			},
			markSessionDefaultName: (sessionId) => {
				const scope = this.scopeRegistry.get(sessionId);
				if (scope) scope.isDefaultName = true;
			},
			emitSessionState: (sessionId, reason) => this.emitSessionState(sessionId, reason),
		});
		this.sessionControlService = new SessionControlService(
			{
				ensureRuntime: (sessionId) => this.ensureRuntime(sessionId),
				getManagedRuntime: (sessionId) => this.runtimeRegistry.get(sessionId),
				getSessionManager: (sessionId) => this.sessionManagerFor(sessionId) ?? undefined,
				updateStoredName: (sessionId, name) => {
					const stored = this.findStoredSession(sessionId);
					if (stored) stored.name = name;
					return stored;
				},
				closeDefaultNameGate: (sessionId) => {
					const scope = this.scopeRegistry.get(sessionId);
					if (scope) scope.isDefaultName = false;
				},
				emitSessionUpdated: (sessionId) => this.emitSessionUpdated(sessionId),
				emitSessionList: (projectId) => this.emitSessionList(projectId),
			},
			this.modelRegistry,
			MAX_NAME_LENGTH,
		);
		this.workspaceFileService = workspaceFileService ?? null;
		this.workspaceTreeService = workspaceTreeService ?? null;
		this.projectDeletionService = new ProjectDeletionService({
			projectService: this.projectService,
			sessionCatalog: this.sessionCatalog,
			runtimeRegistry: this.runtimeRegistry,
			disposeRuntime: (_sessionId, abort) => this.disposeRuntime(_sessionId, abort),
			workspaceFileService: this.workspaceFileService,
			workspaceTreeService: this.workspaceTreeService,
			emitSessionList: (_projectId) => this.emitSessionList(_projectId),
			emitProjectList: () => this.emitProjectList(),
			getActiveSessionId: () => this.activeSessionId,
			setActiveSessionId: (id) => {
				this.activeSessionId = id;
			},
		});
		this.eventProcessor = new SessionEventProcessor(this, this.scopeRegistry, this);
		this.subAgentRuntimeService = new SubAgentRuntimeService(this, this.subAgentRegistry);
		this.sessionSubagentService = new SessionSubagentService({
			host: {
				createManagedRuntime: (cwd, sessionManager, projectId, createdAt, sessionStartEvent, options) =>
					this.createManagedRuntime(cwd, sessionManager, projectId, createdAt, sessionStartEvent, options),
				getManagedRuntime: (sessionId) => this.runtimeRegistry.get(sessionId),
				reloadSession: async (sessionId) => {
					const managed = this.runtimeRegistry.get(sessionId);
					if (managed) await managed.runtime.session.reload();
				},
				listRuntimeIds: () => this.runtimeRegistry.keys(),
				getProjectInfo: (projectId) => this.projectService.getProjectInfo(projectId),
				emit: (event) => this.emit(event),
				emitSessionUpdated: (sessionId) => this.emitSessionUpdated(sessionId),
				getScope: (sessionId) => this.scopeRegistry.get(sessionId),
				acquireScope: (sessionId, projectId) => this.scopeRegistry.acquire(sessionId, projectId),
				runtimeInfo: (sessionId) => this.sessionInfoService.getAgentInfo(sessionId),
			},
			modelRegistry: this.modelRegistry,
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
		this.sessionLifecycleService = new SessionLifecycleService({
			host: {
				createManagedRuntime: (cwd, sessionManager, projectId, createdAt, sessionStartEvent, options) =>
					this.createManagedRuntime(cwd, sessionManager, projectId, createdAt, sessionStartEvent, options),
				disposeRuntime: (sessionId, abort) => this.disposeRuntime(sessionId, abort),
				refreshProjectSessions: (projectId) => this.refreshProjectSessions(projectId),
				getStoredSession: (sessionId) => this.findStoredSession(sessionId),
				emit: (event) => this.emit(event),
				emitSessionState: (sessionId, reason) => this.emitSessionState(sessionId, reason),
				emitSessionList: (projectId) => this.emitSessionList(projectId),
				setActiveProjectId: (projectId) => this.projectService.setActiveId(projectId),
				setActiveSessionId: (id) => {
					this.activeSessionId = id;
				},
				getActiveSessionId: () => this.activeSessionId,
			},
			projectService: this.projectService,
			runtimeRegistry: this.runtimeRegistry,
			scopeRegistry: this.scopeRegistry,
			subAgentRuntimeService: this.subAgentRuntimeService,
			sessionInfoService: this.sessionInfoService,
			permissionService: this.permissionService,
			planService: this.planService,
			userSettings: this.userSettings,
			modelRegistry: this.modelRegistry,
			getAvailableModelsSync: () => this.getAvailableModelsSync(),
		});
		this.sessionMessagingService = new SessionMessagingService({
			ensureRuntime: (sessionId) => this.ensureRuntime(sessionId),
			emitError: (error, sessionId) => this.emitError(error, sessionId),
		});
		this.sessionPermissionOrchestrator = new SessionPermissionOrchestrator({
			host: { ensureRuntime: (sessionId) => this.ensureRuntime(sessionId) },
			permissionService: this.permissionService,
			planService: this.planService,
			userSettings: this.userSettings,
		});
	}

	getWorkspaceFileService(): WorkspaceFileService {
		if (this.disposed) {
			throw new Error("SessionRuntimeManager has been disposed");
		}
		if (!this.workspaceFileService) {
			throw new Error("WorkspaceFileService is not configured for this SessionRuntimeManager");
		}
		return this.workspaceFileService;
	}

	getWorkspaceTreeService(): WorkspaceTreeService {
		if (this.disposed) {
			throw new Error("SessionRuntimeManager has been disposed");
		}
		if (!this.workspaceTreeService) {
			throw new Error("WorkspaceTreeService is not configured for this SessionRuntimeManager");
		}
		return this.workspaceTreeService;
	}

	get customProviders(): CustomProvidersStore {
		return this.customProvidersStore;
	}

	/** O(1) lookup by id. */
	getProjectInfo(projectId: string): ProjectInfo | null {
		return this.projectService.getProjectInfo(projectId);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.workspaceFileService) {
			try {
				await this.workspaceFileService.dispose();
			} catch (error) {
				console.error("[Look] workspaceFileService dispose failed:", error);
			}
		}
		if (this.workspaceTreeService) {
			try {
				await this.workspaceTreeService.dispose();
			} catch (error) {
				console.error("[Look] workspaceTreeService dispose failed:", error);
			}
		}
		await this.disposeAllRuntimes();
		await this.mcpManager.stopAll();
		this.sessionCatalog.clear();
		this.sessionNotifier.clear();
		this.eventBus.clear();
	}

	async loadProjects(): Promise<ProjectInfo[]> {
		return this.projectService.loadProjects();
	}

	async restoreWorkspace(): Promise<number> {
		const refreshPromises: Promise<StoredSession[]>[] = [];
		for (const p of this.projectService.listProjects()) {
			if (p.valid) refreshPromises.push(this.refreshProjectSessions(p.id));
		}
		const results = await Promise.all(refreshPromises);
		const total = results.reduce((sum, sessions) => sum + sessions.length, 0);

		const settings = this.userSettings.getAll();
		const preferredProject = this.projectService.getProjectInfo(settings.lastActiveProjectId);
		const project = preferredProject?.valid ? preferredProject : this.listProjects().find((p) => p.valid);
		if (!project) return total;

		this.projectService.setActiveId(project.id);
		// 立即确定 preferred session ID（不 init runtime），让 renderer 在首帧就
		// 高亮对应 tab 避免 EmptySessionState 闪烁。runtime 由 _autoSelectAgent
		// 或用户点击异步激活。
		const sessions = this.sessionCatalog.listByProject(project.id);
		const preferred = sessions.find((s) => s.id === settings.lastActiveSessionId) ?? sessions[0];
		if (preferred) this.activeSessionId = preferred.id;
		this.emitProjectList();
		return total;
	}

	listProjects(): ProjectInfo[] {
		return this.projectService.listProjects();
	}

	getActiveProject(): ProjectInfo | null {
		return this.projectService.getActiveProject();
	}

	getActiveProjectCwd(): string {
		const project = this.getActiveProject();
		if (!project) throw new Error("No active project. Select a project folder first.");
		if (!project.valid) throw new Error(`Project path does not exist: ${project.cwd}`);
		return project.cwd;
	}

	getProjectRoot(): string {
		return this.getActiveProjectCwd();
	}

	// ── Runtime accessors (IRuntimeStore compat) ──

	getRuntime(sessionId: string): AgentSessionRuntime | undefined {
		return this.runtimeRegistry.get(sessionId)?.runtime;
	}

	getSession(sessionId: string): AgentSession | undefined {
		return this.runtimeRegistry.get(sessionId)?.runtime.session;
	}

	getSessionManager(sessionId: string): SessionManager | undefined {
		return this.runtimeRegistry.get(sessionId)?.runtime.session.sessionManager;
	}

	getCwd(sessionId: string): string {
		const managed = this.runtimeRegistry.get(sessionId);
		if (!managed) throw new Error(`Session ${sessionId} is not live`);
		return managed.runtime.cwd;
	}

	/** Get the stored session file path, even for non-live sessions. */
	getStoredSessionPath(sessionId: string): string | undefined {
		return this.findStoredSession(sessionId)?.path;
	}

	/** Get the cwd for a session (live or stored). */
	getSessionCwd(sessionId: string): string {
		const managed = this.runtimeRegistry.get(sessionId);
		if (managed) return managed.runtime.cwd;
		const stored = this.findStoredSession(sessionId);
		if (stored) return stored.cwd;
		return this.getProjectRoot();
	}

	/** Check if a sub-session cleanup timer is pending. */
	hasCleanupTimer(sessionId: string): boolean {
		return this.subAgentRuntimeService.hasCleanupTimer(sessionId);
	}

	// ── Project trust ──

	getProjectTrustStatus(projectId: string) {
		return this.projectService.getProjectTrustStatus(projectId);
	}

	async setProjectTrust(projectId: string, trusted: boolean): Promise<void> {
		return this.projectRuntimeService.setProjectTrust(projectId, trusted);
	}

	async createProject(cwd: string, name?: string): Promise<{ project: ProjectInfo; isDuplicate: boolean }> {
		const result = await this.projectRuntimeService.createProject(cwd, name);
		await this.setActiveProject(result.project.id);
		return result;
	}

	async setActiveProject(projectId: string): Promise<void> {
		const project = this.projectService.getProjectInfo(projectId);
		if (!project) throw new Error(`Project ${projectId} not found`);
		this.projectService.setActiveId(projectId);
		if (project.valid) await this.refreshProjectSessions(projectId);
		this.emitProjectList();
		this.emit({ type: "project:active-changed", projectId });
		this.emitSessionList(projectId);
	}

	async deleteProject(projectId: string): Promise<void> {
		const project = this.projectService.getProjectInfo(projectId);
		if (!project) return;
		const persisted = this.sessionCatalog.listByProject(projectId);
		const runtimeIds = Array.from(this.runtimeRegistry.entries()).flatMap(([sessionId, managed]) =>
			managed.projectId === projectId ? [sessionId] : [],
		);
		this.emit({
			type: "project:confirm-delete",
			projectId,
			projectName: project.name,
			agentCount: new Set([...persisted.map((session) => session.id), ...runtimeIds]).size,
			runningCount: runtimeIds.filter((sessionId) => {
				const session = this.runtimeRegistry.get(sessionId)?.runtime.session;
				return Boolean(session && (session.isStreaming || session.isRetrying || session.isCompacting));
			}).length,
		});
	}

	async executeDeleteProject(projectId: string): Promise<void> {
		return this.projectDeletionService.executeDelete(projectId);
	}

	renameProject(projectId: string, name: string): void {
		if (this.projectService.renameProject(projectId, name)) {
			this.emitProjectList();
		}
	}

	private async refreshProjectSessions(projectId: string): Promise<StoredSession[]> {
		const project = this.projectService.getProjectInfo(projectId);
		if (!project?.valid) return [];
		return this.sessionCatalog.refresh(project);
	}

	private findStoredSession(sessionId: string): StoredSession | undefined {
		return this.sessionCatalog.get(sessionId);
	}

	listAgents(): AgentInfo[] {
		return this.sessionInfoService.listAgents();
	}

	listAgentsInProject(projectId: string): AgentInfo[] {
		return this.sessionInfoService.listAgentsInProject(projectId);
	}

	getAgentInfo(sessionId: string): AgentInfo | undefined {
		return this.sessionInfoService.getAgentInfo(sessionId);
	}

	private findProjectIdByCwd(cwd: string): string | undefined {
		for (const project of this.projectService.listProjects()) {
			if (project.cwd === cwd) return project.id;
		}
		return undefined;
	}

	private async buildExtensionFactories(_cwd: string, sessionId: string): Promise<ExtensionFactory[]> {
		const projectId = this.runtimeRegistry.get(sessionId)?.projectId ?? "";
		const handler = this.permissionService.createToolCallHandler(_cwd);
		return [
			createPermissionExtensionFactory(handler),
			createPlanExtensionFactory(sessionId, {
				getMode: (id) => this.permissionService.getMode(id),
				askQuestions: (id, questions, signal) => this.planService.requestQuestions(id, questions, signal),
				submitPlan: (id, plan, signal) => this.planService.requestApproval(id, plan, signal),
			}),
			createModelListExtensionFactory(async () => this.getAvailableModels()),
			await createSubagentExtensionFactory(sessionId, this.createSubagentHost(projectId), projectId),
			createMcpExtensionFactory(sessionId, this.mcpManager, _cwd),
		];
	}

	/** 构造 SubagentHost 实现（绑定到本 manager）。 */
	private createSubagentHost(projectId: string): SubagentHost {
		return {
			discoverAgents: async (_projectId, scope) => {
				const result = await discoverAgents(projectId, scope);
				const settings = this.userSettings.getAll();
				const enabledList = settings.enabledAgentDefinitions;
				if (enabledList !== null) {
					result.agents = result.agents.filter((a) => enabledList.includes(a.name));
				}
				return result;
			},
			runSubSession: (parentId, agent, task, signal, onUpdate, title) =>
				this.runSubSession(parentId, agent, task, signal, onUpdate, title),
			isSubagentEnabled: (id) => this.isSubagentEnabled(id),
		};
	}

	private resolveProjectTrust(cwd: string): boolean {
		return this.projectService.resolveProjectTrust(cwd);
	}

	private async createManagedRuntime(
		cwd: string,
		sessionManager: SessionManager,
		projectId: string,
		createdAt = Date.now(),
		sessionStartEvent?: SessionStartEvent,
		factoryOptions?: { appendSystemPrompt?: string[] },
	): Promise<ManagedRuntime> {
		const runtime = await this.runtimeFactory.create(cwd, sessionManager, sessionStartEvent, factoryOptions);
		return this.bindRuntime(runtime, projectId, createdAt);
	}

	private async bindRuntime(
		runtime: AgentSessionRuntime,
		projectId: string,
		createdAt: number,
	): Promise<ManagedRuntime> {
		const session = runtime.session;
		this.permissionService.restoreFromSession(session.sessionId, session.sessionManager);
		this.planService.restoreToolSnapshot(session.sessionId, session.sessionManager);
		await session.bindExtensions({
			mode: "rpc",
			onError: (error) =>
				this.emit({
					type: "error",
					agentId: session.sessionId,
					message: String(error),
				}),
		});
		const managed: ManagedRuntime = {
			runtime,
			projectId,
			createdAt,
			unsubscribe: () => {},
		};
		// Initialize canonical streaming state from the SDK snapshot at bind time.
		// Subsequent transitions are driven by agent_start / agent_end events.
		const scope = this.scopeRegistry.acquire(session.sessionId, projectId);
		scope.streamingState = session.isStreaming ? "streaming" : "idle";
		managed.unsubscribe = session.subscribe((event) => {
			try {
				this.handleSessionEvent(session.sessionId, event);
			} catch (error) {
				console.error("[Look] Error in session event handler:", error);
			}
		});
		runtime.setRebindSession(async (nextSession) => this.rebindRuntime(runtime, nextSession));
		this.runtimeRegistry.set(session.sessionId, managed);
		this.planService.syncToolState(session.sessionId);
		this.sessionSubagentService.applyDefaultOnBind(session.sessionId, session);
		this.emitRuntimeDiagnostics(session.sessionId, runtime);
		return managed;
	}

	private async rebindRuntime(runtime: AgentSessionRuntime, session: AgentSession): Promise<void> {
		const previousEntry = Array.from(this.runtimeRegistry.entries()).find(
			([, managed]) => managed.runtime === runtime,
		);
		if (!previousEntry) throw new Error("Runtime replacement lost its registry entry");
		const [previousSessionId, managed] = previousEntry;
		managed.unsubscribe();
		this.permissionService.cancelPending(previousSessionId);
		this.planService.cancelInteractions(previousSessionId, "Runtime was replaced");
		this.permissionService.disposeSession(previousSessionId);
		this.planService.disposeSession(previousSessionId);
		// Tear down per-session state that was bound to the previous id so
		// it does not leak into the freshly rebound runtime.
		this.autoTitleService.dispose(previousSessionId);
		const prevScope = this.scopeRegistry.get(previousSessionId);
		if (prevScope) prevScope.isDefaultName = false;
		this.scopeRegistry.release(previousSessionId);

		// 为新 sessionId 获取新的 scope，防止 rebind 后事件被静默丢弃。
		const newScope = this.scopeRegistry.acquire(session.sessionId, managed.projectId);
		newScope.streamingState = session.isStreaming ? "streaming" : "idle";
		this.permissionService.restoreFromSession(session.sessionId, session.sessionManager);
		this.planService.restoreToolSnapshot(session.sessionId, session.sessionManager);
		await session.bindExtensions({
			mode: "rpc",
			onError: (error) =>
				this.emit({
					type: "error",
					agentId: session.sessionId,
					message: String(error),
				}),
		});
		this.runtimeRegistry.delete(previousSessionId);
		managed.unsubscribe = session.subscribe((event) => {
			try {
				this.handleSessionEvent(session.sessionId, event);
			} catch (error) {
				console.error("[Look] Error in session event handler:", error);
			}
		});
		this.runtimeRegistry.set(session.sessionId, managed);
		this.planService.syncToolState(session.sessionId);
		this.sessionSubagentService.applyDefaultOnBind(session.sessionId, session);
		if (this.activeSessionId === previousSessionId) this.activeSessionId = session.sessionId;
		this.emitRuntimeDiagnostics(session.sessionId, runtime);
	}

	private emitRuntimeDiagnostics(sessionId: string, runtime: AgentSessionRuntime): void {
		for (const diagnostic of runtime.diagnostics) {
			if (diagnostic.type === "error" || diagnostic.type === "warning") {
				this.emit({
					type: "error",
					agentId: sessionId,
					message: diagnostic.message,
				});
			}
		}
		if (runtime.modelFallbackMessage) {
			this.emit({
				type: "error",
				agentId: sessionId,
				message: runtime.modelFallbackMessage,
			});
		}
	}

	private async ensureRuntime(sessionId: string): Promise<ManagedRuntime> {
		return this.runtimeRegistry.getOrCreate(sessionId, async () => {
			const stored = this.findStoredSession(sessionId);
			if (!stored) throw new Error(`Session ${sessionId} not found`);
			return this.createManagedRuntime(
				stored.cwd,
				SessionManager.open(stored.path),
				stored.projectId,
				stored.created.getTime(),
			);
		});
	}

	async disposeRuntime(sessionId: string, abort = false): Promise<void> {
		await this.runtimeRegistry.awaitInitialization(sessionId);
		const managed = this.runtimeRegistry.get(sessionId);
		if (!managed) return;
		this.permissionService.cancelPending(sessionId);
		this.planService.cancelInteractions(sessionId, "Session runtime was disposed");
		// SubAgent: 释放时结算挂起的子会话执行（标记 aborted），避免父会话工具调用悬空；
		// 并从父子注册表中清理（若本会话是子会话）。
		if (this.subAgentRegistry.hasPending(sessionId)) {
			this.subAgentRuntimeService.finalizeSubSession(sessionId, true);
		}
		this.subAgentRegistry.abortPendingForParent(sessionId);
		this.subAgentRegistry.unregister(sessionId);
		if (abort && managed.runtime.session.isStreaming) await managed.runtime.session.abort();
		this.permissionService.persistIfDirty(sessionId);
		this.planService.persistToolSnapshotIfDirty(sessionId);
		// 取消 AI 标题生成请求并清理 Set 标记。
		this.autoTitleService.dispose(sessionId);
		const dispScope = this.scopeRegistry.get(sessionId);
		if (dispScope) dispScope.isDefaultName = false;
		this.subAgentRuntimeService.cancelSubSessionCleanup(sessionId);
		managed.unsubscribe();
		this.runtimeRegistry.delete(sessionId);
		this.permissionService.disposeSession(sessionId);
		this.planService.disposeSession(sessionId);
		if (dispScope) this.eventProcessor.dispose(sessionId);
		this.scopeRegistry.release(sessionId);
		this.sessionSubagentService.clearSession(sessionId);
		this.sessionNotifier.disposeSession(sessionId);
		this.runtimeRegistry.releaseExclusive(sessionId);
		await managed.runtime.dispose();
	}

	async disposeAllRuntimes(): Promise<void> {
		await Promise.all(
			Array.from(this.runtimeRegistry.keys()).map((sessionId) => this.disposeRuntime(sessionId, true)),
		);
	}

	async activateSession(sessionId: string): Promise<void> {
		if (this.activeSessionId === sessionId && this.runtimeRegistry.has(sessionId)) {
			this.emitSessionState(sessionId, "activate");
			return;
		}
		const managed = await this.ensureRuntime(sessionId);
		this.projectService.setActiveId(managed.projectId);
		this.activeSessionId = sessionId;
		// 取消子会话 runtime 的延迟清理（用户重新激活了它）
		this.subAgentRuntimeService.cancelSubSessionCleanup(sessionId);
		await this.refreshProjectSessions(managed.projectId);
		this.emitProjectList();
		this.emit({ type: "project:active-changed", projectId: managed.projectId });
		this.emitSessionState(sessionId);
	}

	async createAgent(
		opts?: { name?: string; projectId?: string; imProvider?: ImSessionProvider } | string,
	): Promise<string> {
		return this.sessionLifecycleService.createAgent(opts);
	}

	async destroyAgent(sessionId: string): Promise<void> {
		return this.sessionLifecycleService.destroyAgent(sessionId);
	}

	async abortAgent(sessionId: string): Promise<void> {
		return this.sessionLifecycleService.abortAgent(sessionId);
	}

	private sessionManagerFor(sessionId: string): SessionManager | null {
		const managed = this.runtimeRegistry.get(sessionId);
		if (managed) return managed.runtime.session.sessionManager;
		const stored = this.findStoredSession(sessionId);
		return stored && existsSync(stored.path) ? SessionManager.open(stored.path) : null;
	}

	async sendMessage(sessionId: string, text: string, images?: ImageContent[]): Promise<void> {
		return this.sessionMessagingService.sendMessage(sessionId, text, images);
	}

	// ============================================================
	// SubAgent 子会话生命周期
	// ============================================================

	isSubagentEnabled(sessionId: string): boolean {
		return this.sessionSubagentService.isEnabled(sessionId);
	}

	/**
	 * 全局切换 SubAgent 开关：应用到所有活动会话（动态增删 subagent 工具），
	 * 更新默认值（新会话继承），并持久化到 user-settings。
	 */
	async setSubagentEnabledGlobal(enabled: boolean): Promise<void> {
		return this.sessionSubagentService.setEnabledGlobal(enabled);
	}

	/** 设置单个 Agent 定义的启用状态。 */
	async setAgentDefinitionEnabled(name: string, enabled: boolean): Promise<void> {
		return this.sessionSubagentService.setAgentDefinitionEnabled(name, enabled);
	}

	/** 设置单个 Skill 的启用状态。 */
	async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
		const settings = this.userSettings.getAll();
		let list = settings.enabledSkills;
		if (list === null) {
			const all = this.listSkillsForUI().skills.map((s) => s.name);
			if (all.length === 0) return;
			list = enabled ? all : all.filter((n) => n !== name);
		} else {
			list = enabled ? [...new Set([...list, name])] : list.filter((n) => n !== name);
		}
		await this.userSettings.update({ enabledSkills: list });
	}

	/** Stage 2：切换 Agent 开关。Stage 1 默认 true，此方法为后续阶段预留。 */
	async setSubagentEnabled(sessionId: string, enabled: boolean): Promise<void> {
		return this.sessionSubagentService.setEnabledForSession(sessionId, enabled);
	}

	/** 列出某父会话下的全部子会话 ID。 */
	listSubSessions(parentSessionId: string): string[] {
		return this.subAgentRegistry.listChildren(parentSessionId);
	}

	/** 查询子会话的父会话 ID（无则 null）。 */
	getParentSession(childSessionId: string): string | null {
		return this.subAgentRegistry.getParent(childSessionId);
	}

	// ============================================================
	// SubAgent — Agent 定义 CRUD（委托给 AgentDefinitionService）
	// ============================================================

	async listAgentDefinitions(): Promise<AgentDefinitionInfo[]> {
		return this.agentDefinitionService.listDefinitions();
	}

	async createAgentDefinition(input: AgentDefinitionInput): Promise<AgentDefinitionInfo> {
		return this.agentDefinitionService.createDefinition(input);
	}

	async updateAgentDefinition(name: string, input: AgentDefinitionInput): Promise<AgentDefinitionInfo> {
		return this.agentDefinitionService.updateDefinition(name, input);
	}

	deleteAgentDefinition(name: string): void {
		this.agentDefinitionService.deleteDefinition(name);
	}

	async installAgentDefinition(name: string): Promise<AgentDefinitionInfo> {
		return this.agentDefinitionService.installDefinition(name);
	}

	/**
	 * 创建并运行一个 subagent 子会话，返回其最终结果。
	 *
	 * 子会话作为完整 Look 会话注册到本 manager：与父会话共享 cwd/projectId，
	 * 但 session 文件存放在独立的 subsessions/ 子目录，不污染顶层会话列表。
	 * 父子关系同时记录在内存注册表和子会话 JSONL 的自定义条目中。
	 */
	async runSubSession(
		parentSessionId: string,
		agent: AgentConfig,
		task: string,
		signal: AbortSignal | undefined,
		onUpdate?: (progress: SubagentProgress) => void,
		title?: string,
	): Promise<SubagentResult> {
		return this.sessionSubagentService.runSubSession(parentSessionId, agent, task, signal, onUpdate, title);
	}

	async setModel(sessionId: string, modelKey: string): Promise<void> {
		await this.sessionControlService.setModel(sessionId, modelKey);
	}

	async setThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<void> {
		await this.sessionControlService.setThinkingLevel(sessionId, level);
	}

	async compressSession(sessionId: string): Promise<void> {
		await this.sessionControlService.compress(sessionId);
	}

	renameAgent(sessionId: string, name: string): void {
		this.sessionControlService.rename(sessionId, name);
	}

	async navigateTreeSession(
		sessionId: string,
		entryId: string,
		opts?: { summarize?: boolean; customInstructions?: string; label?: string },
	): Promise<NavigateTreeResult> {
		return this.sessionHistoryService.navigate(sessionId, entryId, opts);
	}

	async createForkedSession(
		sessionId: string,
		entryId: string,
		opts?: { name?: string },
	): Promise<ForkedSessionResult> {
		return this.sessionHistoryService.fork(sessionId, entryId, opts);
	}

	setEntryLabel(sessionId: string, entryId: string, label: string | null): void {
		this.sessionHistoryService.setEntryLabel(sessionId, entryId, label);
	}

	/**
	 * 首条 user 消息 message_end 事件时调用。
	 * 仅在 scope.isDefaultName 为 true 的 session 触发，
	 * 把决策权完全交给 Service 内部的并发 / abort / generated 守卫。
	 */
	private async onUserMessageEndForTitle(sessionId: string, userMsg: AgentMessage): Promise<void> {
		const managed = this.runtimeRegistry.get(sessionId);
		if (!managed) return;
		const currentName = managed.runtime.session.sessionManager.getSessionName();
		const titleScope = this.scopeRegistry.get(sessionId);
		const isDefaultName =
			(titleScope?.isDefaultName ?? false) && (!currentName || currentName === DEFAULT_SESSION_NAME);
		await this.autoTitleService.generateForFirstUserMessage(
			managed.runtime.session,
			userMsg,
			isDefaultName,
			sessionId,
		);
	}

	// ── ISessionEventHost implementation ──

	async onAgentEnd(sessionId: string, _willRetry: boolean): Promise<void> {
		this.permissionService.persistIfDirty(sessionId);
		this.planService.persistToolSnapshotIfDirty(sessionId);
		this.persistTurnDurationIfPossible(sessionId);
		await this.refreshAfterTurn(sessionId).catch((error) => this.emitError(error, sessionId));
	}

	onAgentStart(sessionId: string): number {
		const now = Date.now();
		return now;
	}

	async onMessageEnd(sessionId: string, message: AgentMessage): Promise<void> {
		if (message.role === "assistant") {
			this.subAgentRuntimeService.trackSubSessionMessageEnd(sessionId, message);
			if (message.stopReason !== "aborted") {
				const model = (message as { model?: string }).model;
				const cost = (message as { usage?: { cost?: { total?: number } } }).usage?.cost?.total;
				incrementTurn(formatLocalDate(Date.now()), model, cost);
				// 防抖 300ms，合并同一批次内的多次 turn 完成事件
				if (this.usageUpdateTimer) clearTimeout(this.usageUpdateTimer);
				this.usageUpdateTimer = setTimeout(() => {
					this.usageUpdateTimer = null;
					this.emit({ type: "usage:updated" });
				}, 300);
			}
		}
		if (message.role === "user") {
			await this.onUserMessageEndForTitle(sessionId, message).catch((err) => {
				if (process.env.DEBUG_AUTO_TITLE === "1") {
					console.warn("[Look][autoTitle] trigger failed:", err);
				}
			});
		}
	}

	onSubSessionAgentEnd(sessionId: string): void {
		if (this.subAgentRegistry.hasPending(sessionId)) {
			this.subAgentRuntimeService.finalizeSubSession(sessionId);
		}
	}

	// ── SDK event entry point (delegated to SessionEventProcessor) ──

	private handleSessionEvent(sessionId: string, event: AgentSessionEvent): void {
		this.eventProcessor.handle(sessionId, event);
	}

	private async refreshAfterTurn(sessionId: string): Promise<void> {
		const projectId = this.runtimeRegistry.get(sessionId)?.projectId ?? this.findStoredSession(sessionId)?.projectId;
		if (!projectId) return;
		await this.refreshProjectSessions(projectId);
		this.emitSessionUpdated(sessionId);
		this.emitSessionList(projectId);
	}

	// ISessionEventHost — public for interface compatibility
	emitSessionState(targetSessionId?: string, reason: SessionSnapshotEnvelope["reason"] = "activate"): void {
		this.sessionNotifier.emitSessionState(targetSessionId ?? this.activeSessionId, reason);
	}

	/** ISessionEventHost — 每次 tool_execution_end 时检查并推送 TODO.md 进度 */
	emitTodoUpdate(sessionId: string): void {
		this.sessionNotifier.emitTodoUpdate(sessionId);
	}

	// ISessionEventHost — public for interface compatibility
	emitSessionUpdated(sessionId: string): void {
		this.sessionNotifier.emitSessionUpdated(sessionId);
	}

	// ISessionEventHost — 流式输出时轻量推送 contextUsage（500ms 节流）
	emitContextUsage(sessionId: string): void {
		this.sessionNotifier.emitContextUsage(sessionId);
	}

	private emitSessionList(projectId: string): void {
		this.sessionNotifier.emitSessionList(projectId);
	}

	private emitProjectList(): void {
		this.sessionNotifier.emitProjectList();
	}

	setApiKey(provider: string, key: string): void {
		this.modelProviderService.setApiKey(provider, key);
	}

	getApiKey(provider: string): string | undefined {
		return this.modelProviderService.getApiKey(provider);
	}

	async testApiKey(provider: string, key: string) {
		return this.modelProviderService.testApiKey(provider, key);
	}

	async testEnvKey(provider: string) {
		return this.modelProviderService.testEnvKey(provider);
	}

	getAvailableModelsSync() {
		// Filter to providers with explicitly configured auth (stored keys,
		// models.json keys, runtime overrides, custom providers). Exclude
		// providers that are only reachable via environment variables — the
		// user didn't opt into those through the settings UI and ModelSelector
		// should align with what the API Keys tab shows as "configured".
		// Also exclude providers with no configured auth at all — without this
		// guard, built-in providers whose key is missing would still appear
		// here (auth.source is undefined when configured=false) and the new-
		// session fallback would pick one, fail to setModel, and silently leave
		// the SDK's default (typically anthropic/claude-opus-4-8) in place.
		return this.modelRegistry.getAvailable().flatMap((model) => {
			const auth = this.modelRegistry.getProviderAuthStatus(model.provider);
			if (auth.source === "environment") return [];
			if (!auth.configured) return [];
			return [
				{
					provider: model.provider,
					id: model.id,
					name: model.name ?? model.id,
					reasoning: model.reasoning ?? false,
					contextWindow: model.contextWindow ?? 128000,
					maxTokens: model.maxTokens ?? 16384,
					cost: {
						input: model.cost?.input ?? 0,
						output: model.cost?.output ?? 0,
					},
				},
			];
		});
	}

	async getAvailableModels() {
		return this.modelProviderService.getAvailableModels();
	}

	async getProviders() {
		return this.modelProviderService.getProviders();
	}

	async getProviderSettings() {
		const customList = this.customProvidersStore.list();
		const customNames = new Set(customList.map((p) => p.name));
		const providers = await this.getProviders();
		const filtered = providers.flatMap((provider) => {
			if (customNames.has(provider.id)) return [];
			const auth = this.modelRegistry.getProviderAuthStatus(provider.id);
			const models = this.getAvailableModelsSync().filter((model) => model.provider === provider.id);
			return [
				{
					id: provider.id,
					name: provider.name,
					hasKey: provider.hasCredentials,
					envVar: auth.source === "environment" ? auth.label : undefined,
					modelsAvailable: models.length,
					models,
					authSource: auth.source,
					envLabel: auth.label,
				},
			];
		});

		const customConfigured = customList.filter((cp) => !!cp.apiKey).length;
		const customTotalModels = customList.reduce((sum, cp) => sum + cp.models.length, 0);

		return {
			providers: filtered,
			customStats: {
				configured: customConfigured,
				totalModels: customTotalModels,
			},
		};
	}

	getPermissionMode(sessionId: string): PermissionMode {
		return this.permissionService.getMode(sessionId);
	}

	async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
		return this.sessionPermissionOrchestrator.applyMode(sessionId, mode, {
			internal: false,
			updateDefault: true,
		});
	}

	handlePermissionResponse(payload: PermissionRespondPayload): boolean {
		return this.permissionService.handleResponse(payload);
	}

	handlePlanQuestionResponse(payload: PlanQuestionResponse): boolean {
		return this.planService.handleQuestionResponse(payload);
	}

	async handlePlanApprovalResponse(payload: PlanApprovalResponse): Promise<boolean> {
		return this.planService.handleApprovalResponse(payload);
	}

	private persistTurnDurationIfPossible(sessionId: string): void {
		const session = this.runtimeRegistry.get(sessionId)?.runtime.session;
		const scope = this.scopeRegistry.get(sessionId);
		const turnStartedAt = scope?.turnStartedAt ?? null;
		if (scope) scope.turnStartedAt = null;
		if (!session || !turnStartedAt) return;
		persistTurnDuration(session, turnStartedAt);
	}

	getGeneralSettings(): UserSettings {
		return this.userSettings.getAll();
	}

	async updateGeneralSettings(partial: Partial<UserSettings>): Promise<UserSettings> {
		const settings = await this.userSettings.update(partial);
		if (partial.compactionEnabled !== undefined) {
			for (const managed of this.runtimeRegistry.values()) {
				managed.runtime.session.setAutoCompactionEnabled(partial.compactionEnabled);
			}
		}
		if (partial.permissionMode !== undefined) this.permissionService.setDefaultMode(partial.permissionMode);
		if (partial.subagentEnabled !== undefined) {
			this.sessionSubagentService.setDefaultEnabled(partial.subagentEnabled);
			await Promise.all(
				Array.from(this.runtimeRegistry.keys()).map((sessionId) =>
					this.sessionSubagentService.setEnabledForSession(sessionId, partial.subagentEnabled as boolean),
				),
			);
		}
		return settings;
	}

	async resetGeneralSettings(): Promise<UserSettings> {
		const settings = await this.userSettings.reset();
		this.permissionService.setDefaultMode(settings.permissionMode);
		this.sessionSubagentService.setDefaultEnabled(settings.subagentEnabled);
		this.globalSettingsManager.setDefaultProjectTrust("ask");
		return settings;
	}

	listSkillsForUI() {
		const activeRuntime = this.activeSessionId ? this.runtimeRegistry.get(this.activeSessionId)?.runtime : undefined;
		const skillPaths =
			activeRuntime?.services.settingsManager.getSkillPaths() ?? this.globalSettingsManager.getSkillPaths();
		const loaded = activeRuntime?.services.resourceLoader.getSkills() ?? {
			skills: [],
			diagnostics: [],
		};

		const rawSkills = loaded.skills.length > 0 ? loaded.skills : discoverSkillsFromPaths(skillPaths);
		const skillsWithCategory = rawSkills.map((s) => ({
			...s,
			category: isBuiltinSkillPath(s) ? ("builtin" as const) : ("mine" as const),
		}));
		return {
			skills: skillsWithCategory,
			diagnostics: loaded.diagnostics,
			importedPaths: skillPaths,
		};
	}

	async importSkillPaths(paths: string[]): Promise<{ success: boolean; importedCount: number; error?: string }> {
		try {
			const activeRuntime = this.activeSessionId
				? this.runtimeRegistry.get(this.activeSessionId)?.runtime
				: undefined;
			const settingsManager = activeRuntime?.services.settingsManager ?? this.globalSettingsManager;
			const merged = Array.from(
				new Set(
					[...settingsManager.getSkillPaths(), ...paths].flatMap((item) => {
						const resolved = item.startsWith("~") ? join(homedir(), item.slice(1)) : item;
						return existsSync(resolved) ? [resolved] : [];
					}),
				),
			);
			settingsManager.setSkillPaths(merged);
			await settingsManager.flush();
			await Promise.all(
				Array.from(this.runtimeRegistry.values()).map((managed) => managed.runtime.session.reload()),
			);
			return { success: true, importedCount: merged.length };
		} catch (error) {
			return {
				success: false,
				importedCount: 0,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	detectCommonSkillPaths() {
		return detectCommonSkillPaths();
	}

	onEvent(callback: EventCallback): () => void {
		return this.eventBus.onEvent(callback);
	}

	public emit(event: MainToRendererEvent): void {
		this.eventBus.emit(event);
	}

	private emitError(error: unknown, sessionId?: string): void {
		this.sessionNotifier.emitError(error, sessionId ?? this.activeSessionId ?? undefined);
	}
}
