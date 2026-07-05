import fs, { existsSync } from "node:fs";
import { homedir } from "node:os";
import path, { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	AuthStorage,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionFactory,
	hasTrustRequiringProjectResources,
	ModelRegistry,
	type SessionInfo as PiSessionInfo,
	ProjectTrustStore,
	SessionManager,
	type SessionStartEvent,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AgentDefinitionService } from "../agents/definition-service.js";
import type { IEventBus, IPermissionService, IPlanService, IRuntimeStore, ISessionScope } from "../core/contracts.js";
import { createMcpExtensionFactory } from "../extensions/mcp-extension.js";
import { createPermissionExtensionFactory } from "../extensions/permission-extension.js";
import { createPlanExtensionFactory } from "../extensions/plan-extension.js";
import { discoverAgents } from "../extensions/subagent/agent-discovery.js";
import { createSubagentExtensionFactory } from "../extensions/subagent/subagent-extension.js";
import type { AgentConfig, SubagentHost, SubagentProgress, SubagentResult } from "../extensions/subagent/types.js";
import { loadBindings } from "../im/im-storage.js";
import { MCPManager } from "../mcp/manager.js";
import { ModelProviderService } from "../models/model-provider-service.js";
import { PlanService } from "../permissions/plan.js";
import { PermissionService } from "../permissions/service.js";
import { ProjectService } from "../projects/project-service.js";
import { AutoTitleService } from "../services/auto-title.js";
import { persistTurnDuration } from "../services/turn-metrics.js";
import type { ISessionEventHost } from "../session/event-processor.js";
import { SessionEventProcessor } from "../session/event-processor.js";
import { SessionScopeRegistry } from "../session/scope-registry.js";
import type { PendingSubSession } from "../session/subagent-registry.js";
import { SubAgentRegistry } from "../session/subagent-registry.js";
import { UIEventBatcher } from "../session/ui-event-batcher.js";
import { CustomProvidersStore } from "../settings/custom-providers.js";
import { migrateLegacySettings } from "../settings/migrate.js";
import { PromptStore } from "../settings/prompt-store.js";
import { type UserSettings, UserSettingsStore } from "../settings/store.js";
import {
	ensureLookDir,
	ensureWorkspaceDir,
	ensureWorkspaceSubsessionsDir,
	getAuthPath,
	getCustomProvidersPath,
	getLookDir,
	getModelsPath,
	getProjectSharedDir,
	getProjectSystemPromptPath,
	getUiSettingsPath,
	getWorkspaceDir,
	getWorkspaceSubsessionsDir,
	resetLegacySessionsOnce,
} from "../shared/look-storage.js";
import { DEFAULT_SESSION_NAME } from "../shared/session-defaults.js";
import type {
	AgentDefinitionInfo,
	AgentDefinitionInput,
	AgentInfo,
	ForkedSessionResult,
	ImSessionProvider,
	LookUiEvent,
	MainToRendererEvent,
	NavigateTreeResult,
	PermissionMode,
	PermissionRespondPayload,
	PlanApprovalOutcome,
	PlanApprovalRequest,
	PlanApprovalResponse,
	PlanQuestionOutcome,
	PlanQuestionRequest,
	PlanQuestionResponse,
	ProjectInfo,
	SessionSnapshotEnvelope,
	ThinkingLevel,
} from "../shared/types.js";
import {
	detectCommonSkillPaths,
	discoverSkillsFromPaths,
	isBuiltinSkillPath,
} from "../skills/skill-discovery-service.js";
import { formatLocalDate, incrementTurn } from "../system/usage.js";
import type { WorkspaceFileService } from "../workspace/workspace-file-service.js";
import type { WorkspaceTreeService } from "../workspace/workspace-tree-service.js";
import { scanSessionDirectory } from "./scan.js";
import { parseTodoFile } from "./todo-parser.js";

export type { EventCallback } from "../shared/types.js";

import type { EventCallback } from "../shared/types.js";

interface StoredSession extends PiSessionInfo {
	projectId: string;
}

interface ManagedRuntime {
	readonly runtime: AgentSessionRuntime;
	readonly projectId: string;
	readonly createdAt: number;
	unsubscribe: () => void;
}

const MAX_NAME_LENGTH = 80;
/** 子会话超时（5 分钟）：若 agent_end 未在此时限内触发，强制结算为 aborted。 */
const SUBAGENT_TIMEOUT_MS = 5 * 60 * 1000;
/** 最大子会话递归深度：防止 LLM 无限嵌套调用 subagent 工具。 */
const MAX_SUBAGENT_DEPTH = 5;
/** 子会话 JSONL 中记录父会话链接的自定义条目类型。
 *  符合 AGENTS.md：parent links 由 pi JSONL 拥有。 */
const SUBAGENT_PARENT_ENTRY_TYPE = "look.subagent-parent.v1";

interface PendingPlanQuestion {
	request: PlanQuestionRequest;
	resolve: (outcome: PlanQuestionOutcome) => void;
	removeAbortListener: () => void;
}

interface PendingPlanApproval {
	request: PlanApprovalRequest;
	resolve: (outcome: PlanApprovalOutcome) => void;
	removeAbortListener: () => void;
	resolving: boolean;
}

// PendingSubSession 类型已移至 subagent-registry.ts

/**
 * Hosts independent pi AgentSessionRuntime instances for sessions that are
 * selected or currently running. Each runtime still owns exactly one active pi
 * session; Look only supplies the cross-session registry and event routing.
 *
 * Implements IEventBus and IRuntimeStore so domain services can depend on
 * abstractions instead of the concrete SRT class.
 */
export class SessionRuntimeManager implements IEventBus, IRuntimeStore, ISessionEventHost {
	// projects Map migrated to ProjectService
	private readonly sessionsByProject = new Map<string, StoredSession[]>();
	private readonly sessionsById = new Map<string, StoredSession>();
	private readonly eventCallbacks: EventCallback[] = [];
	private readonly authStorage: AuthStorage;
	private readonly modelRegistry: ModelRegistry;
	private readonly customProvidersStore: CustomProvidersStore;
	private readonly modelProviderService: ModelProviderService;
	private readonly projectService: ProjectService;
	private readonly scopeRegistry = new SessionScopeRegistry();
	private readonly subAgentRegistry = new SubAgentRegistry();
	private readonly uiBatcher: UIEventBatcher;
	private readonly eventProcessor: SessionEventProcessor;
	private readonly trustStore: ProjectTrustStore;
	private readonly globalSettingsManager: SettingsManager;
	private readonly userSettings: UserSettingsStore;
	// projectsIndexPath migrated to ProjectService
	private readonly runtimes = new Map<string, ManagedRuntime>();
	private readonly runtimeInitializations = new Map<string, Promise<ManagedRuntime>>();
	private readonly forkOperationTails = new Map<string, Promise<void>>();
	private resourceInitializationTail: Promise<void> = Promise.resolve();
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

	// ---- SubAgent 子会话注册表 ----
	// 数据已迁移至 SubAgentRegistry（src/main/session/subagent-registry.ts）
	/** Agent 开关：sessionId → enabled（Stage 2 持久化；Stage 1 默认 true） */
	private readonly subagentEnabledBySession = new Map<string, boolean>();
	/** SubAgent 全局默认开关（新会话继承）。由 user-settings 持久化。 */
	private subagentDefaultEnabled = true;

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
		this.subagentDefaultEnabled = this.userSettings.getAll().subagentEnabled;
		this.permissionService = new PermissionService(this, this, this.userSettings.getAll().permissionMode);
		// Tool authorization must never silently grant trust to project resources.
		this.globalSettingsManager.setDefaultProjectTrust("ask");
		this.autoTitleService = new AutoTitleService({
			modelRegistry: this.modelRegistry,
			getUserSettings: () => this.userSettings.getAll(),
		});
		this.promptStore = new PromptStore();
		this.agentDefinitionService = new AgentDefinitionService(() => this.reloadAllSessionsForAgents());
		this.planService = new PlanService(this, this, this.permissionService, async (sessionId) => {
			await this.applyPermissionMode(sessionId, "always", { internal: true, updateDefault: false });
		});
		// projectsIndexPath is managed by ProjectService internally
		this.mcpManager = new MCPManager();
		this.mcpManager.setOnChange(() => this.emit({ type: "mcp:status-changed" }));
		this.eventProcessor = new SessionEventProcessor(this, this.scopeRegistry, this);
		this.uiBatcher = new UIEventBatcher(this);
		this.workspaceFileService = workspaceFileService ?? null;
		this.workspaceTreeService = workspaceTreeService ?? null;
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
		const sessions = this.sessionsByProject.get(project.id) ?? [];
		const preferred = sessions.find((s) => s.id === settings.lastActiveSessionId) ?? sessions[0];
		if (preferred) this.activeSessionId = preferred.id;
		this.emitProjectList();
		return total;
	}

	private saveProjects(): void {
		this.projectService.saveProjects();
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

	// ── IRuntimeStore implementation ──

	getRuntime(sessionId: string): AgentSessionRuntime | undefined {
		return this.runtimes.get(sessionId)?.runtime;
	}

	getSession(sessionId: string): AgentSession | undefined {
		return this.runtimes.get(sessionId)?.runtime.session;
	}

	getSessionManager(sessionId: string): SessionManager | undefined {
		return this.runtimes.get(sessionId)?.runtime.session.sessionManager;
	}

	getCwd(sessionId: string): string {
		const managed = this.runtimes.get(sessionId);
		if (!managed) throw new Error(`Session ${sessionId} is not live`);
		return managed.runtime.cwd;
	}

	// ── Project trust ──

	getProjectTrustStatus(projectId: string) {
		return this.projectService.getProjectTrustStatus(projectId);
	}

	async setProjectTrust(projectId: string, trusted: boolean): Promise<void> {
		const project = this.projectService.getProjectInfo(projectId);
		if (!project?.valid) throw new Error(`Project ${projectId} not found`);
		this.trustStore.set(project.cwd, trusted);
		const reloadPromises: Promise<void>[] = [];
		for (const managed of this.runtimes.values()) {
			if (managed.runtime.cwd !== project.cwd) continue;
			reloadPromises.push(
				(async () => {
					managed.runtime.services.settingsManager.setProjectTrusted(trusted);
					await managed.runtime.session.reload();
				})(),
			);
		}
		await Promise.all(reloadPromises);
	}

	async createProject(cwd: string, name?: string): Promise<{ project: ProjectInfo; isDuplicate: boolean }> {
		if (!existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
			throw new Error(`Project path is not a directory: ${cwd}`);
		}
		const canonicalCwd = fs.realpathSync(cwd);
		const existing = this.projectService.findByCwd(canonicalCwd);
		if (existing) {
			await this.setActiveProject(existing.id);
			return { project: existing, isDuplicate: true };
		}

		const project = this.projectService.createProjectRecord(canonicalCwd, name);
		this.sessionsByProject.set(project.id, []);
		this.saveProjects();
		await this.setActiveProject(project.id);
		return { project, isDuplicate: false };
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
		const persisted = this.sessionsByProject.get(projectId) ?? [];
		const runtimeIds = Array.from(this.runtimes.entries()).flatMap(([sessionId, managed]) =>
			managed.projectId === projectId ? [sessionId] : [],
		);
		this.emit({
			type: "project:confirm-delete",
			projectId,
			projectName: project.name,
			agentCount: new Set([...persisted.map((session) => session.id), ...runtimeIds]).size,
			runningCount: runtimeIds.filter((sessionId) => {
				const session = this.runtimes.get(sessionId)?.runtime.session;
				return Boolean(session && (session.isStreaming || session.isRetrying || session.isCompacting));
			}).length,
		});
	}

	async executeDeleteProject(projectId: string): Promise<void> {
		const project = this.projectService.getProjectInfo(projectId);
		const sessions = this.sessionsByProject.get(projectId) ?? [];
		const runtimeIds: string[] = [];
		for (const [sessionId, managed] of this.runtimes.entries()) {
			if (managed.projectId === projectId) runtimeIds.push(sessionId);
		}
		const sharedDir = getProjectSharedDir(projectId);
		const workspaceDir = project ? getWorkspaceDir(project.name) : null;
		await Promise.all(runtimeIds.map((sessionId) => this.disposeRuntime(sessionId, true)));
		// 先停 watcher,再删目录,避免 chokidar 监听已删 inode 持续报错
		if (this.workspaceFileService) {
			try {
				await this.workspaceFileService.stopWatching(projectId);
			} catch (error) {
				console.error(`[Look] Failed to stop shared area watcher for ${projectId}:`, error);
			}
		}
		if (this.workspaceTreeService) {
			try {
				await this.workspaceTreeService.stopAllWatchesForProject(projectId);
			} catch (error) {
				console.error(`[Look] Failed to stop workspace tree watchers for ${projectId}:`, error);
			}
		}
		for (const session of sessions) {
			try {
				fs.unlinkSync(session.path);
			} catch (error: any) {
				if (error?.code !== "ENOENT") throw error;
			}
		}
		this.sessionsByProject.delete(projectId);
		this.projectService.removeProject(projectId);
		// 删除项目时清理共享区 + 整个 workspace 目录（含 sessions / subsessions / schedule-sessions）。
		// 之前只清 subsessions 留下了孤儿 session 数据，正是导致 ~/.look/workspaces/<name>/
		// 越攒越多的根因；这里改成一次性 rmSync 整个 workspace 目录，保证删除是完整的。
		if (existsSync(sharedDir)) {
			try {
				fs.rmSync(sharedDir, { recursive: true, force: true });
			} catch (error: any) {
				if (error?.code !== "ENOENT") {
					console.error(`Failed to remove shared area for project ${projectId}:`, error);
				}
			}
		}
		if (workspaceDir && existsSync(workspaceDir)) {
			try {
				fs.rmSync(workspaceDir, { recursive: true, force: true });
				if (project) {
					console.log(`[Look] Removed workspace for deleted project "${project.name}" (${projectId})`);
				}
			} catch (error: any) {
				if (error?.code !== "ENOENT") {
					console.error(`Failed to remove workspace for project ${projectId}:`, error);
				}
			}
		}
		if (this.activeSessionId && runtimeIds.includes(this.activeSessionId)) this.activeSessionId = null;
		if (this.projectService.activeId === projectId) {
			this.projectService.setActiveId(this.listProjects().find((project) => project.valid)?.id ?? null);
		}
		this.saveProjects();
		this.emitSessionList(projectId);
		this.emitProjectList();
		if (this.projectService.activeId) this.emitSessionList(this.projectService.activeId);
	}

	renameProject(projectId: string, name: string): void {
		if (this.projectService.renameProject(projectId, name)) {
			this.emitProjectList();
		}
	}

	private async refreshProjectSessions(projectId: string): Promise<StoredSession[]> {
		const project = this.projectService.getProjectInfo(projectId);
		if (!project?.valid) return [];
		const sessions = (await scanSessionDirectory(ensureWorkspaceDir(project.name), project.cwd)).map((session) => ({
			...session,
			projectId,
		}));

		// Stage 4：扫描 subsessions/ 目录恢复子会话，使用轻量行读取避免 SessionManager.open
		// 解析整个大文件（每个子会话可能有大量消息）。
		const subsessionsDir = getWorkspaceSubsessionsDir(project.name);
		if (existsSync(subsessionsDir)) {
			let subsessionFiles: string[];
			try {
				subsessionFiles = fs.readdirSync(subsessionsDir).filter((f) => f.endsWith(".jsonl"));
			} catch {
				subsessionFiles = [];
			}
			for (const file of subsessionFiles) {
				try {
					const filePath = path.join(subsessionsDir, file);
					// 轻量扫描：只读 session header + custom 条目，不全量解析消息
					const meta = this.scanSubsessionMeta(filePath);
					if (!meta) continue;
					const { sessionId, parentSessionId, agentName, firstMessage, messageCount, created } = meta;
					if (parentSessionId) {
						this.subAgentRegistry.register(parentSessionId, sessionId, agentName ?? "");
					}
					const stored: StoredSession = {
						id: sessionId,
						name: meta.displayName || firstMessage || "",
						firstMessage: firstMessage || "",
						messageCount,
						created: new Date(created),
						path: filePath,
						cwd: project.cwd,
						projectId,
						modified: new Date(created),
						allMessagesText: "",
					};
					// 避免同 ID（不太可能但防御）
					if (!sessions.some((s) => s.id === sessionId)) {
						sessions.push(stored);
					}
				} catch (err) {
					// 单个子会话文件损坏或解析失败，跳过不影响整体
					console.warn(`[Look] Failed to restore subagent session from ${file}:`, err);
				}
			}
		}

		this.sessionsByProject.set(projectId, sessions);
		this.rebuildSessionsIndex();
		return sessions;
	}

	private findStoredSession(sessionId: string): StoredSession | undefined {
		return (
			this.sessionsById.get(sessionId) ??
			Array.from(this.sessionsByProject.values())
				.flat()
				.find((s) => s.id === sessionId)
		);
	}

	private rebuildSessionsIndex(): void {
		this.sessionsById.clear();
		for (const sessions of this.sessionsByProject.values()) {
			for (const session of sessions) {
				this.sessionsById.set(session.id, session);
			}
		}
	}
	private sessionInfo(session: StoredSession): AgentInfo {
		const managed = this.runtimes.get(session.id);
		const piSession = managed?.runtime.session;
		const stats = piSession?.getSessionStats();
		const model = piSession?.model;
		return {
			id: session.id,
			name: (session.name || session.firstMessage || DEFAULT_SESSION_NAME).slice(0, MAX_NAME_LENGTH),
			imProvider: this.getImProvider(session.id),
			model: model ? `${model.provider}/${model.id}` : "",
			thinkingLevel: (piSession?.thinkingLevel as ThinkingLevel | undefined) ?? "off",
			modelSupportsThinking: piSession?.supportsThinking() ?? false,
			availableThinkingLevels: (piSession?.getAvailableThinkingLevels() as ThinkingLevel[] | undefined) ?? ["off"],
			isStreaming: piSession?.isStreaming ?? false,
			isRetrying: piSession?.isRetrying ?? false,
			isCompacting: piSession?.isCompacting ?? false,
			messageCount: stats?.totalMessages ?? session.messageCount,
			createdAt: session.created.getTime(),
			sessionFilePath: session.path,
			projectId: session.projectId,
			contextUsage: piSession?.getContextUsage(),
			...this.subagentFields(session.id),
		};
	}

	private runtimeInfo(sessionId: string, managed: ManagedRuntime): AgentInfo {
		const session = managed.runtime.session;
		const stats = session.getSessionStats();
		const model = session.model;
		return {
			id: sessionId,
			name: (session.sessionManager.getSessionName() || DEFAULT_SESSION_NAME).slice(0, MAX_NAME_LENGTH),
			imProvider: this.getImProvider(sessionId),
			model: model ? `${model.provider}/${model.id}` : "",
			thinkingLevel: session.thinkingLevel as ThinkingLevel,
			modelSupportsThinking: session.supportsThinking(),
			availableThinkingLevels: session.getAvailableThinkingLevels() as ThinkingLevel[],
			isStreaming: this.isStreaming(sessionId, session.isStreaming),
			isRetrying: session.isRetrying,
			isCompacting: session.isCompacting,
			messageCount: stats.totalMessages,
			createdAt: managed.createdAt,
			sessionFilePath: session.sessionFile && existsSync(session.sessionFile) ? session.sessionFile : undefined,
			projectId: managed.projectId,
			contextUsage: session.getContextUsage(),
			...this.subagentFields(sessionId),
		};
	}

	private getImProvider(sessionId: string): ImSessionProvider | undefined {
		const scope = this.scopeRegistry.get(sessionId);
		if (scope?.imProvider) return scope.imProvider as ImSessionProvider;
		const binding = loadBindings().find((item) => item.sessionId === sessionId);
		return binding ? "feishu" : undefined;
	}

	/** 返回子会话标识字段；非子会话返回空对象（展开后无影响）。 */
	private subagentFields(
		sessionId: string,
	): Pick<AgentInfo, "parentSessionId" | "isSubagentSession" | "agentConfigName"> {
		const meta = this.subAgentRegistry.getMeta(sessionId);
		if (!meta) return {};
		return {
			parentSessionId: meta.parentSessionId,
			isSubagentSession: true,
			agentConfigName: meta.agentName,
		};
	}

	listAgents(): AgentInfo[] {
		return this.listProjects().flatMap((project) => this.listAgentsInProject(project.id));
	}

	listAgentsInProject(projectId: string): AgentInfo[] {
		const persistedEntries = this.sessionsByProject.get(projectId) ?? [];
		// For sessions that still have a live runtime, prefer the runtime's
		// view (which reads `session.sessionManager.getSessionName()`) over
		// the cached `StoredSession`. The cache only refreshes on
		// `refreshProjectSessions`, but `setSessionName` writes to the
		// session file in-place — so a freshly applied auto-title would be
		// invisible in the cached `session.name` until the next refresh,
		// causing `agent:list` to roll the tab title back to the default.
		const persisted = persistedEntries.map((session) => {
			const managed = this.runtimes.get(session.id);
			return managed ? this.runtimeInfo(session.id, managed) : this.sessionInfo(session);
		});
		const persistedIds = new Set(persistedEntries.map((session) => session.id));
		const drafts = Array.from(this.runtimes.entries()).flatMap(([sessionId, managed]) =>
			managed.projectId === projectId && !persistedIds.has(sessionId) ? [this.runtimeInfo(sessionId, managed)] : [],
		);
		return [...drafts, ...persisted];
	}

	getAgentInfo(sessionId: string): AgentInfo | undefined {
		const managed = this.runtimes.get(sessionId);
		if (managed) return this.runtimeInfo(sessionId, managed);
		const session = this.findStoredSession(sessionId);
		return session ? this.sessionInfo(session) : undefined;
	}

	private findProjectIdByCwd(cwd: string): string | undefined {
		for (const project of this.projectService.listProjects()) {
			if (project.cwd === cwd) return project.id;
		}
		return undefined;
	}

	private createRuntimeFactory(factoryOptions?: { appendSystemPrompt?: string[] }): CreateAgentSessionRuntimeFactory {
		return async ({ cwd, sessionManager, sessionStartEvent }) => {
			return this.withResourceInitialization(async () => {
				const settingsManager = SettingsManager.create(cwd, getLookDir());
				const resolveLatestProjectTrust = () => {
					const trusted = this.resolveProjectTrust(cwd);
					settingsManager.setProjectTrusted(trusted);
					return trusted;
				};
				resolveLatestProjectTrust();
				const projectId = this.findProjectIdByCwd(cwd);
				const sharedPath = projectId ? getProjectSharedDir(projectId) : undefined;
				const sharedPrompt = sharedPath
					? `\n## 共享区（Shared Area）\n项目共享文件目录：${sharedPath}\n你可以通过 read、write、edit、ls 等工具访问此目录。这些文件在同一项目的所有会话中共享，新建或打开历史会话均可读取。\n`
					: undefined;
				const appendPrompts = [sharedPrompt, ...(factoryOptions?.appendSystemPrompt ?? [])].filter(
					(p): p is string => typeof p === "string" && p.length > 0,
				);

				// 项目级提示词：如果项目 SYSTEM.md 存在，显式传入 .look 路径
				// SDK resolvePromptInput 会读取文件内容作为 customPrompt
				let systemPromptSource: string | undefined;
				if (projectId) {
					const projectPromptPath = getProjectSystemPromptPath(projectId);
					if (existsSync(projectPromptPath)) {
						systemPromptSource = projectPromptPath;
					}
				}
				// 未传入时 SDK 自动发现 ~/.look/SYSTEM.md（全局提示词）

				const services = await createAgentSessionServices({
					cwd,
					agentDir: getLookDir(),
					authStorage: this.authStorage,
					modelRegistry: this.modelRegistry,
					settingsManager,
					resourceLoaderOptions: {
						extensionFactories: this.buildExtensionFactories(cwd, sessionManager.getSessionId()),
						appendSystemPrompt: appendPrompts.length > 0 ? appendPrompts : undefined,
						systemPrompt: systemPromptSource,
					},
					resourceLoaderReloadOptions: {
						resolveProjectTrust: async () => resolveLatestProjectTrust(),
					},
				});
				const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
				return { ...result, services, diagnostics: services.diagnostics };
			});
		};
	}

	private async withResourceInitialization<T>(task: () => Promise<T>): Promise<T> {
		const previous = this.resourceInitializationTail;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => gate);
		this.resourceInitializationTail = tail;
		await previous;
		try {
			return await task();
		} finally {
			release();
			if (this.resourceInitializationTail === tail) this.resourceInitializationTail = Promise.resolve();
		}
	}

	private buildExtensionFactories(_cwd: string, sessionId: string): ExtensionFactory[] {
		const projectId = this.runtimes.get(sessionId)?.projectId ?? "";
		const handler = this.permissionService.createToolCallHandler(_cwd);
		return [
			createPermissionExtensionFactory(handler),
			createPlanExtensionFactory(sessionId, {
				getMode: (id) => this.permissionService.getMode(id),
				askQuestions: (id, questions, signal) => this.planService.requestQuestions(id, questions, signal),
				submitPlan: (id, plan, signal) => this.planService.requestApproval(id, plan, signal),
			}),
			createSubagentExtensionFactory(sessionId, this.createSubagentHost(projectId), projectId),
			createMcpExtensionFactory(sessionId, this.mcpManager, _cwd),
		];
	}

	/** 构造 SubagentHost 实现（绑定到本 manager）。 */
	private createSubagentHost(projectId: string): SubagentHost {
		return {
			discoverAgents: (_projectId, scope) => {
				const result = discoverAgents(projectId, scope);
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
		const runtime = await createAgentSessionRuntime(this.createRuntimeFactory(factoryOptions), {
			cwd,
			agentDir: getLookDir(),
			sessionManager,
			sessionStartEvent,
		});
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
			onError: (error) => this.emit({ type: "error", agentId: session.sessionId, message: String(error) }),
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
		managed.unsubscribe = session.subscribe((event) => this.handleSessionEvent(session.sessionId, event));
		runtime.setRebindSession(async (nextSession) => this.rebindRuntime(runtime, nextSession));
		this.runtimes.set(session.sessionId, managed);
		this.planService.syncToolState(session.sessionId);
		this.applySubagentDefaultOnBind(session.sessionId, session);
		this.emitRuntimeDiagnostics(session.sessionId, runtime);
		return managed;
	}

	private async rebindRuntime(runtime: AgentSessionRuntime, session: AgentSession): Promise<void> {
		const previousEntry = Array.from(this.runtimes.entries()).find(([, managed]) => managed.runtime === runtime);
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
		this.permissionService.restoreFromSession(session.sessionId, session.sessionManager);
		this.planService.restoreToolSnapshot(session.sessionId, session.sessionManager);
		await session.bindExtensions({
			mode: "rpc",
			onError: (error) => this.emit({ type: "error", agentId: session.sessionId, message: String(error) }),
		});
		this.runtimes.delete(previousSessionId);
		managed.unsubscribe = session.subscribe((event) => this.handleSessionEvent(session.sessionId, event));
		this.runtimes.set(session.sessionId, managed);
		this.planService.syncToolState(session.sessionId);
		this.applySubagentDefaultOnBind(session.sessionId, session);
		if (this.activeSessionId === previousSessionId) this.activeSessionId = session.sessionId;
		this.emitRuntimeDiagnostics(session.sessionId, runtime);
	}

	private emitRuntimeDiagnostics(sessionId: string, runtime: AgentSessionRuntime): void {
		for (const diagnostic of runtime.diagnostics) {
			if (diagnostic.type === "error" || diagnostic.type === "warning") {
				this.emit({ type: "error", agentId: sessionId, message: diagnostic.message });
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
		const existing = this.runtimes.get(sessionId);
		if (existing) return existing;
		const pending = this.runtimeInitializations.get(sessionId);
		if (pending) return pending;
		const stored = this.findStoredSession(sessionId);
		if (!stored) throw new Error(`Session ${sessionId} not found`);
		const initialization = this.createManagedRuntime(
			stored.cwd,
			SessionManager.open(stored.path),
			stored.projectId,
			stored.created.getTime(),
		).finally(() => this.runtimeInitializations.delete(sessionId));
		this.runtimeInitializations.set(sessionId, initialization);
		return initialization;
	}

	private async disposeRuntime(sessionId: string, abort = false): Promise<void> {
		const pending = this.runtimeInitializations.get(sessionId);
		if (pending) await pending.catch(() => undefined);
		const managed = this.runtimes.get(sessionId);
		if (!managed) return;
		this.permissionService.cancelPending(sessionId);
		this.planService.cancelInteractions(sessionId, "Session runtime was disposed");
		// SubAgent: 释放时结算挂起的子会话执行（标记 aborted），避免父会话工具调用悬空；
		// 并从父子注册表中清理（若本会话是子会话）。
		if (this.subAgentRegistry.hasPending(sessionId)) {
			this.finalizeSubSession(sessionId, true);
		}
		this.unregisterSubSession(sessionId);
		if (abort && managed.runtime.session.isStreaming) await managed.runtime.session.abort();
		this.permissionService.persistIfDirty(sessionId);
		this.planService.persistToolSnapshotIfDirty(sessionId);
		// 取消 AI 标题生成请求并清理 Set 标记。
		this.autoTitleService.dispose(sessionId);
		const dispScope = this.scopeRegistry.get(sessionId);
		if (dispScope) dispScope.isDefaultName = false;
		managed.unsubscribe();
		this.runtimes.delete(sessionId);
		this.permissionService.disposeSession(sessionId);
		this.planService.disposeSession(sessionId);
		if (dispScope) this.clearUiEventBuffer(dispScope);
		this.scopeRegistry.release(sessionId);
		await managed.runtime.dispose();
	}

	async disposeAllRuntimes(): Promise<void> {
		await Promise.all(Array.from(this.runtimes.keys()).map((sessionId) => this.disposeRuntime(sessionId, true)));
	}

	async activateSession(sessionId: string): Promise<void> {
		if (this.activeSessionId === sessionId && this.runtimes.has(sessionId)) {
			this.emitSessionState(sessionId, "activate");
			return;
		}
		const managed = await this.ensureRuntime(sessionId);
		this.projectService.setActiveId(managed.projectId);
		this.activeSessionId = sessionId;
		await this.refreshProjectSessions(managed.projectId);
		this.emitProjectList();
		this.emit({ type: "project:active-changed", projectId: managed.projectId });
		this.emitSessionState(sessionId);
	}

	async createAgent(
		opts?: { name?: string; projectId?: string; imProvider?: ImSessionProvider } | string,
	): Promise<string> {
		const input = typeof opts === "string" ? { name: opts } : (opts ?? {});
		const projectId = input.projectId ?? this.projectService.activeId;
		if (!projectId) throw new Error("No active project");
		const project = this.projectService.getProjectInfo(projectId);
		if (!project?.valid) throw new Error(`Project path does not exist: ${project?.cwd ?? projectId}`);

		const managed = await this.createManagedRuntime(
			project.cwd,
			SessionManager.create(project.cwd, ensureWorkspaceDir(project.name)),
			projectId,
		);
		const session = managed.runtime.session;
		session.setSessionName((input.name?.trim() || DEFAULT_SESSION_NAME).slice(0, MAX_NAME_LENGTH));
		// 如果用户未设置偏好模型，使用 API Keys 已连接模型列表的第一个
		if (!this.userSettings.getAll().preferredModel) {
			const available = this.getAvailableModelsSync();
			if (available.length > 0) {
				const first = available[0];
				const model = this.modelRegistry.find(first.provider, first.id);
				if (model && this.modelRegistry.hasConfiguredAuth(model)) {
					await session.setModel(model);
				}
			}
		}
		// 标记为"刚创建、还是默认名"，AI 标题生成只覆盖此集合。
		const scope = this.scopeRegistry.get(session.sessionId);
		if (scope) scope.isDefaultName = true;
		if (input.imProvider) {
			const scope = this.scopeRegistry.get(session.sessionId);
			if (scope) scope.imProvider = input.imProvider;
		}
		this.projectService.setActiveId(projectId);
		this.activeSessionId = session.sessionId;
		await this.refreshProjectSessions(projectId);
		this.emit({
			type: "agent:created",
			agentId: session.sessionId,
			agent: this.runtimeInfo(session.sessionId, managed),
		});
		this.emitSessionState(session.sessionId, "initial");
		return session.sessionId;
	}

	async destroyAgent(sessionId: string): Promise<void> {
		// 级联销毁所有子会话（删除父会话时同步清理子会话）
		await this.destroySubSessions(sessionId);
		const stored = this.findStoredSession(sessionId);
		const managed = this.runtimes.get(sessionId);
		const projectId = stored?.projectId ?? managed?.projectId;
		if (!projectId) return;
		await this.disposeRuntime(sessionId, true);
		if (stored) {
			try {
				fs.unlinkSync(stored.path);
			} catch (error: any) {
				if (error?.code !== "ENOENT") throw error;
			}
		}
		if (this.activeSessionId === sessionId) this.activeSessionId = null;
		await this.refreshProjectSessions(projectId);
		this.emit({ type: "agent:destroyed", agentId: sessionId });
		this.emitSessionList(projectId);
	}

	private sessionManagerFor(sessionId: string): SessionManager | null {
		const managed = this.runtimes.get(sessionId);
		if (managed) return managed.runtime.session.sessionManager;
		const stored = this.findStoredSession(sessionId);
		return stored && existsSync(stored.path) ? SessionManager.open(stored.path) : null;
	}

	async sendMessage(sessionId: string, text: string, images?: ImageContent[]): Promise<void> {
		const managed = await this.ensureRuntime(sessionId);
		const session = managed.runtime.session;

		// 解析 /agent:name 模式：/skill 仍归 pi 技能命令，单 @ 保留给 pi 文件引用。
		const agentTokens = Array.from(
			text.matchAll(/(?:^|\s)\/(?:agent|subagent):([A-Za-z0-9][A-Za-z0-9._-]*)(?=$|\s)/g),
		);
		if (agentTokens.length > 0) {
			const discovery = discoverAgents(managed.projectId, "both");
			const agentNames = agentTokens.flatMap((match) => match[1] ?? []);
			const foundAgents = agentNames.flatMap((name) => {
				const found = discovery.agents.find((a) => a.name === name);
				return found ? [found] : [];
			});

			if (foundAgents.length > 0) {
				// 保留原文 /agent:name chip，仅追加一行最小指令
				const names = foundAgents.map((a) => a.name).join(", ");
				const hint = foundAgents.length === 1 ? `[Use subagent: ${names}]` : `[Use subagents: ${names}]`;
				text = `${hint}\n\n${text}`;
			}
		}

		// 统一发送路径
		await new Promise<void>((resolve, reject) => {
			let accepted = false;
			void session
				.prompt(text, {
					images,
					source: "rpc",
					streamingBehavior: session.isStreaming ? "followUp" : undefined,
					preflightResult: (success) => {
						if (!success || accepted) return;
						accepted = true;
						resolve();
					},
				})
				.catch((error) => {
					if (!accepted) reject(error);
					else this.emitError(error, sessionId);
				});
		});
	}

	async abortAgent(sessionId: string): Promise<void> {
		const managed = this.runtimes.get(sessionId);
		if (!managed) return;
		// 级联中止所有子会话（subagent 调用随父会话中止而中止）。
		await this.abortSubSessions(sessionId);
		this.permissionService.cancelPending(sessionId);
		this.planService.cancelInteractions(sessionId, "Stopped by user");
		await managed.runtime.session.abort();
	}

	// ============================================================
	// SubAgent 子会话生命周期
	// ============================================================

	isSubagentEnabled(sessionId: string): boolean {
		return this.subagentEnabledBySession.get(sessionId) ?? this.subagentDefaultEnabled;
	}

	/**
	 * 全局切换 SubAgent 开关：应用到所有活动会话（动态增删 subagent 工具），
	 * 更新默认值（新会话继承），并持久化到 user-settings。
	 */
	async setSubagentEnabledGlobal(enabled: boolean): Promise<void> {
		this.subagentDefaultEnabled = enabled;
		await this.userSettings.update({ subagentEnabled: enabled });
		await Promise.all(
			Array.from(this.runtimes.keys()).map((sessionId) => this.applySubagentEnabled(sessionId, enabled)),
		);
	}

	/** 设置单个 Agent 定义的启用状态。 */
	async setAgentDefinitionEnabled(name: string, enabled: boolean): Promise<void> {
		const settings = this.userSettings.getAll();
		let list = settings.enabledAgentDefinitions;
		if (list === null) {
			const all = this.listAgentDefinitions().map((a) => a.name);
			list = enabled ? all : all.filter((n) => n !== name);
		} else {
			list = enabled ? [...new Set([...list, name])] : list.filter((n) => n !== name);
		}
		await this.userSettings.update({ enabledAgentDefinitions: list });
		this.reloadAllSessionsForAgents();
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

	/** 把 enabled 状态应用到单个会话：动态增删 subagent 工具 + 记录 per-session 状态。 */
	private async applySubagentEnabled(sessionId: string, enabled: boolean): Promise<void> {
		this.subagentEnabledBySession.set(sessionId, enabled);
		const managed = this.runtimes.get(sessionId);
		if (!managed) return;
		const session = managed.runtime.session;
		if (this.getPermissionMode(sessionId) === "plan") {
			this.planService.syncToolState(sessionId);
			return;
		}
		if (enabled) {
			// 只恢复 subagent 工具本身,不要重置当前会话已有的 active tools。
			const configured = new Set(session.getAllTools().map((tool) => tool.name));
			if (!configured.has("subagent")) return;
			const active = session.getActiveToolNames();
			if (!active.includes("subagent")) session.setActiveToolsByName([...active, "subagent"]);
		} else {
			// 关闭：从活动工具中移除 subagent，LLM 即不可见不可调用。
			session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "subagent"));
		}
	}

	/** Stage 2：切换 Agent 开关。Stage 1 默认 true，此方法为后续阶段预留。 */
	async setSubagentEnabled(sessionId: string, enabled: boolean): Promise<void> {
		await this.applySubagentEnabled(sessionId, enabled);
	}

	/**
	 * 新会话绑定时应用全局默认开关。仅当默认关闭时移除 subagent 工具；
	 * 默认开启时不触碰活动工具集，避免破坏 plan 模式的工具限制。
	 */
	private applySubagentDefaultOnBind(sessionId: string, session: AgentSession): void {
		if (this.subagentDefaultEnabled) return;
		this.subagentEnabledBySession.set(sessionId, false);
		session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "subagent"));
	}

	/**
	 * 轻量扫描子会话 JSONL 元数据——只读 session header + custom/message 条目行，
	 * 不全量解析消息内容。比 SessionManager.open() + getEntries() 快 5-10x。
	 */
	private scanSubsessionMeta(filePath: string): {
		sessionId: string;
		displayName?: string;
		parentSessionId?: string;
		agentName?: string;
		firstMessage?: string;
		messageCount: number;
		created: number;
	} | null {
		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const lines = raw.split("\n");
			let sessionId = "";
			let displayName: string | undefined;
			let parentSessionId: string | undefined;
			let agentName: string | undefined;
			let firstMessage: string | undefined;
			let messageCount = 0;
			let created = Date.now();
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const entry = JSON.parse(line) as Record<string, unknown>;
					if (entry.type === "session") {
						sessionId = String(entry.id ?? "");
						if (entry.timestamp) created = new Date(String(entry.timestamp)).getTime();
					} else if (entry.type === "session_info") {
						displayName = String(entry.name ?? "") || undefined;
					} else if (entry.type === "custom" && entry.customType === SUBAGENT_PARENT_ENTRY_TYPE) {
						const data = entry.data as { parentSessionId?: string; agentName?: string } | undefined;
						if (data?.parentSessionId) parentSessionId = data.parentSessionId;
						if (data?.agentName) agentName = data.agentName;
					} else if (entry.type === "message") {
						messageCount++;
						if (!firstMessage) {
							const msg = entry.message as { content?: unknown; timestamp?: number } | undefined;
							const content = msg?.content;
							if (typeof content === "string") firstMessage = content;
							else if (Array.isArray(content) && (content[0] as { type?: string })?.type === "text") {
								firstMessage = (content[0] as { text: string }).text;
							}
							if (msg?.timestamp && msg.timestamp < created) created = msg.timestamp;
						}
					}
				} catch {
					/* skip malformed lines */
				}
			}
			if (!sessionId) return null;
			return { sessionId, displayName, parentSessionId, agentName, firstMessage, messageCount, created };
		} catch {
			return null;
		}
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

	listAgentDefinitions(): AgentDefinitionInfo[] {
		return this.agentDefinitionService.listDefinitions();
	}

	createAgentDefinition(input: AgentDefinitionInput): AgentDefinitionInfo {
		return this.agentDefinitionService.createDefinition(input);
	}

	updateAgentDefinition(name: string, input: AgentDefinitionInput): AgentDefinitionInfo {
		return this.agentDefinitionService.updateDefinition(name, input);
	}

	deleteAgentDefinition(name: string): void {
		this.agentDefinitionService.deleteDefinition(name);
	}

	installAgentDefinition(name: string): AgentDefinitionInfo {
		return this.agentDefinitionService.installDefinition(name);
	}

	/** Agent 定义变更后，重载所有活动会话以刷新 subagent 工具的可用 Agent 列表。 */
	private async reloadAllSessionsForAgents(): Promise<void> {
		await Promise.all(
			Array.from(this.runtimes.values()).map((managed) =>
				managed.runtime.session.reload().catch((error) => {
					console.warn("[Look][subagent] Failed to reload session after agent definition change:", error);
				}),
			),
		);
		this.emit({ type: "subagent:definitions-updated" });
	}

	/** 级联中止子会话（不删除文件，可继续查看历史）。 */
	private async abortSubSessions(parentSessionId: string): Promise<void> {
		const childIds = this.listSubSessions(parentSessionId);
		await Promise.all(
			childIds.map(async (childId) => {
				const child = this.runtimes.get(childId);
				if (child?.runtime.session.isStreaming) {
					await child.runtime.session.abort().catch(() => undefined);
				}
			}),
		);
	}

	/** 级联销毁子会话（dispose runtime + 删除 session 文件 + 清理注册表）。 */
	private async destroySubSessions(parentSessionId: string): Promise<void> {
		const childIds = this.listSubSessions(parentSessionId);
		await Promise.all(
			childIds.map(async (childId) => {
				const childFile =
					this.runtimes.get(childId)?.runtime.session.sessionFile ?? this.findStoredSession(childId)?.path;
				await this.disposeRuntime(childId, true).catch(() => undefined);
				if (childFile && existsSync(childFile)) {
					try {
						fs.unlinkSync(childFile);
					} catch (error: any) {
						if (error?.code !== "ENOENT") throw error;
					}
				}
				this.unregisterSubSession(childId);
				this.emit({ type: "agent:destroyed", agentId: childId });
			}),
		);
	}

	private registerSubSession(parentSessionId: string, childSessionId: string, agentName: string): void {
		this.subAgentRegistry.register(parentSessionId, childSessionId, agentName);
	}

	private unregisterSubSession(childSessionId: string): void {
		this.subAgentRegistry.unregister(childSessionId);
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
		const parentManaged = this.runtimes.get(parentSessionId);
		if (!parentManaged) throw new Error(`Parent session ${parentSessionId} is not live`);

		// 检查子会话递归深度，防止 LLM 无限嵌套调用 subagent 工具
		let subDepth = 0;
		let ancestor = parentSessionId;
		while (true) {
			const parent = this.subAgentRegistry.getParent(ancestor);
			if (!parent) break;
			subDepth++;
			ancestor = parent;
			if (subDepth >= MAX_SUBAGENT_DEPTH) {
				throw new Error(
					`Subagent nesting limit of ${MAX_SUBAGENT_DEPTH} exceeded. Cannot create nested sub-session under ${parentSessionId}.`,
				);
			}
		}
		const projectId = parentManaged.projectId;
		const project = this.projectService.getProjectInfo(projectId);
		if (!project?.valid) throw new Error(`Project not found or invalid for subagent: ${projectId}`);
		const cwd = parentManaged.runtime.cwd;

		// 子会话存放在独立子目录，避免污染顶层 SessionManager.list 结果。
		const subsessionDir = ensureWorkspaceSubsessionsDir(project.name);
		const sessionManager = SessionManager.create(cwd, subsessionDir);
		const managed = await this.createManagedRuntime(
			cwd,
			sessionManager,
			projectId,
			Date.now(),
			undefined,
			agent.systemPrompt.trim() ? { appendSystemPrompt: [agent.systemPrompt] } : undefined,
		);
		const session = managed.runtime.session;
		const childSessionId = session.sessionId;

		// 命名：优先使用 LLM 提供的 title，否则拼接 agentName + task 摘要
		const rawName = title?.trim()
			? title.trim()
			: `${agent.title || agent.name} · ${task.replace(/\s+/g, " ").trim().slice(0, 48)}`;
		const displayName = `Agent：${rawName}`.slice(0, MAX_NAME_LENGTH);
		session.setSessionName(displayName);

		// 工具白名单（与已配置工具取交集，避免激活不存在的工具）
		if (agent.tools && agent.tools.length > 0) {
			const configured = new Set(session.getAllTools().map((tool) => tool.name));
			const allowlisted = agent.tools.filter((name) => configured.has(name));
			if (allowlisted.length > 0) session.setActiveToolsByName(allowlisted);
		}

		// 模型（找不到则继承父会话模型）
		if (agent.model) {
			try {
				const slash = agent.model.indexOf("/");
				if (slash > 0) {
					const model = this.modelRegistry.find(agent.model.slice(0, slash), agent.model.slice(slash + 1));
					if (model) await session.setModel(model);
				}
			} catch (error) {
				console.warn(`[Look][subagent] Failed to set model ${agent.model}:`, error);
			}
		}

		// 父子关系持久化到子会话 JSONL（符合 AGENTS.md：parent links 由 pi JSONL 拥有）
		session.sessionManager.appendCustomEntry(SUBAGENT_PARENT_ENTRY_TYPE, {
			parentSessionId,
			agentName: displayName,
		});
		this.registerSubSession(parentSessionId, childSessionId, displayName);

		// 通知渲染层子会话已创建（含 parentSessionId，Stage 4 据此嵌套）
		this.emit({
			type: "agent:created",
			agentId: childSessionId,
			agent: this.runtimeInfo(childSessionId, managed),
		});

		// 建立完成跟踪（必须在 prompt 之前，避免错过 agent_end）
		const resultPromise = this.setupSubSessionTracking(
			childSessionId,
			parentSessionId,
			agent,
			task,
			signal,
			onUpdate,
			displayName,
		);

		// 发送任务 prompt 启动子会话执行
		await new Promise<void>((resolve, reject) => {
			let accepted = false;
			void session
				.prompt(task, {
					source: "rpc",
					streamingBehavior: session.isStreaming ? "followUp" : undefined,
					preflightResult: (success) => {
						if (!success || accepted) return;
						accepted = true;
						resolve();
					},
				})
				.catch((error) => {
					if (!accepted) reject(error);
					else this.emitError(error, childSessionId);
				});
		}).catch((error) => {
			// prompt 接受失败：finalize 为 failed 并清理
			this.finalizeSubSession(childSessionId, true);
			throw error;
		});

		return resultPromise;
	}

	/** 建立子会话完成跟踪，返回在 agent_end（非 retry）时 resolve 的结果 Promise。 */
	private setupSubSessionTracking(
		childSessionId: string,
		parentSessionId: string,
		agent: AgentConfig,
		task: string,
		signal: AbortSignal | undefined,
		onUpdate?: (progress: SubagentProgress) => void,
		displayName?: string,
	): Promise<SubagentResult> {
		const pending: PendingSubSession = {
			childSessionId,
			parentSessionId,
			agent,
			task,
			displayName: displayName || agent.title || agent.name,
			resolve: undefined!,
			onUpdate,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			removeAbortListener: () => {},
			aborted: false,
		};
		this.subAgentRegistry.addPending(pending);

		// 父会话中止 → 中止子会话
		if (signal) {
			const onAbort = () => {
				pending.aborted = true;
				const managed = this.runtimes.get(childSessionId);
				if (managed?.runtime.session.isStreaming) {
					managed.runtime.session.abort().catch(() => undefined);
				}
			};
			signal.addEventListener("abort", onAbort, { once: true });
			pending.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		}

		const timeout = setTimeout(() => {
			this.finalizeSubSession(childSessionId, true);
		}, SUBAGENT_TIMEOUT_MS);

		return new Promise<SubagentResult>((resolve) => {
			pending.resolve = (result: SubagentResult) => {
				clearTimeout(timeout);
				resolve(result);
			};
		});
	}

	/** 在子会话 agent_end（非 retry）或异常时结算结果并 resolve。 */
	private finalizeSubSession(childSessionId: string, forceFailed = false): void {
		const pending = this.subAgentRegistry.removePending(childSessionId);
		if (!pending) return;
		pending.removeAbortListener();

		const managed = this.runtimes.get(childSessionId);
		const finalOutput = managed ? this.getFinalAssistantText(managed.runtime.session) : "";
		let status: "completed" | "failed" | "aborted";
		if (forceFailed || pending.aborted) status = "aborted";
		else if (pending.stopReason === "error") status = "failed";
		else status = "completed";

		const result: SubagentResult = {
			sessionId: childSessionId,
			agentName: pending.displayName,
			agentSource: pending.agent.source,
			task: pending.task,
			status,
			finalOutput: finalOutput || pending.errorMessage || "(no output)",
			usage: pending.usage,
			model: pending.model,
			stopReason: pending.stopReason,
			errorMessage: pending.errorMessage,
		};

		this.emit({
			type: "session:subagent-completed",
			parentSessionId: pending.parentSessionId,
			childSessionId,
			agentName: pending.displayName,
			result: {
				sessionId: result.sessionId,
				agentName: result.agentName,
				status,
				finalOutput: result.finalOutput,
				model: result.model,
				stopReason: result.stopReason,
				errorMessage: result.errorMessage,
			},
		});
		pending.resolve(result);
	}

	/** 取子会话最后一条 assistant 消息的文本输出。 */
	private getFinalAssistantText(session: AgentSession): string {
		const branch = session.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message?.role === "assistant") {
				for (const part of entry.message.content) {
					if (part.type === "text") return part.text;
				}
			}
		}
		return "";
	}

	/** 子会话 assistant message_end：累计用量、记录模型/停止原因，并向父会话推送进度。 */
	private trackSubSessionMessageEnd(sessionId: string, message: AgentMessage): void {
		const pending = this.subAgentRegistry.getPending(sessionId);
		if (!pending) return;
		pending.usage.turns += 1;
		const usage = (
			message as {
				usage?: {
					input?: number;
					output?: number;
					cacheRead?: number;
					cacheWrite?: number;
					cost?: { total?: number };
					totalTokens?: number;
				};
			}
		).usage;
		if (usage) {
			pending.usage.input += usage.input ?? 0;
			pending.usage.output += usage.output ?? 0;
			pending.usage.cacheRead += usage.cacheRead ?? 0;
			pending.usage.cacheWrite += usage.cacheWrite ?? 0;
			pending.usage.cost += usage.cost?.total ?? 0;
			pending.usage.contextTokens = usage.totalTokens ?? pending.usage.contextTokens;
		}
		const model = (message as { model?: string }).model;
		if (model) pending.model = model;
		const stopReason = (message as { stopReason?: string }).stopReason;
		if (stopReason) pending.stopReason = stopReason;
		const errorMessage = (message as { errorMessage?: string }).errorMessage;
		if (errorMessage) pending.errorMessage = errorMessage;

		const childSession = this.runtimes.get(sessionId)?.runtime.session;
		const partialOutput = childSession ? this.getFinalAssistantText(childSession) : "";
		this.emit({
			type: "session:subagent-progress",
			parentSessionId: pending.parentSessionId,
			childSessionId: sessionId,
			agentName: pending.displayName,
			task: pending.task,
			status: "running",
			partialOutput,
			usage: {
				input: pending.usage.input,
				output: pending.usage.output,
				cacheRead: pending.usage.cacheRead,
				cacheWrite: pending.usage.cacheWrite,
				cost: pending.usage.cost,
				turns: pending.usage.turns,
			},
			model: pending.model,
		});
		pending.onUpdate?.({
			childSessionId: sessionId,
			parentSessionId: pending.parentSessionId,
			agentName: pending.displayName,
			task: pending.task,
			status: "running",
			partialOutput,
			usage: pending.usage,
			model: pending.model,
		});
	}

	async setModel(sessionId: string, modelKey: string): Promise<void> {
		const session = (await this.ensureRuntime(sessionId)).runtime.session;
		const slash = modelKey.indexOf("/");
		if (slash <= 0) throw new Error(`Model key must be in provider/model form: ${modelKey}`);
		const model = this.modelRegistry.find(modelKey.slice(0, slash), modelKey.slice(slash + 1));
		if (!model) throw new Error(`Model not found: ${modelKey}`);
		await session.setModel(model);
		this.emitSessionUpdated(sessionId);
	}

	async setThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<void> {
		const managed = await this.ensureRuntime(sessionId);
		managed.runtime.session.setThinkingLevel(level);
	}

	async compressSession(sessionId: string): Promise<void> {
		const session = (await this.ensureRuntime(sessionId)).runtime.session;
		if (!session.isStreaming) await session.compact();
	}

	renameAgent(sessionId: string, name: string): void {
		const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
		if (!trimmed) return;
		const managed = this.runtimes.get(sessionId);
		if (managed) {
			managed.runtime.session.setSessionName(trimmed);
		} else {
			const manager = this.sessionManagerFor(sessionId);
			manager?.appendSessionInfo(trimmed);
		}
		// User-initiated rename: drop the session from the "still on default
		// name" set so the auto-title gate closes permanently. The service's
		// `generated` Set never needs clearing here — once the gate is closed
		// by the Set deletion, the next message_end computes `isDefaultName
		// === false` and the service short-circuits before reaching any
		// `generated` check.
		const renScope = this.scopeRegistry.get(sessionId);
		if (renScope) renScope.isDefaultName = false;
		const stored = this.findStoredSession(sessionId);
		if (stored) stored.name = trimmed;
		this.emitSessionUpdated(sessionId);
		if (stored) this.emitSessionList(stored.projectId);
	}

	async navigateTreeSession(
		sessionId: string,
		entryId: string,
		opts?: { summarize?: boolean; customInstructions?: string; label?: string },
	): Promise<NavigateTreeResult> {
		const session = (await this.ensureRuntime(sessionId)).runtime.session;
		const result = await session.navigateTree(entryId, opts);
		if (!result.cancelled) this.emitSessionState(sessionId, "navigate");
		return result;
	}

	async createForkedSession(
		sessionId: string,
		entryId: string,
		opts?: { name?: string },
	): Promise<ForkedSessionResult> {
		return this.withForkLock(sessionId, async () => {
			const managed = await this.ensureRuntime(sessionId);
			const sourceSession = managed.runtime.session;
			if (sourceSession.isStreaming || sourceSession.isRetrying || sourceSession.isCompacting) {
				throw new Error("Stop the session before forking");
			}
			const sourceFile = sourceSession.sessionFile;
			if (!sourceFile) throw new Error("Source session not persisted");
			if (!sourceSession.sessionManager.getEntry(entryId)) throw new Error("Invalid entry ID for forking");

			const runner = sourceSession.extensionRunner;
			if (runner.hasHandlers("session_before_fork")) {
				const hookResult = await runner.emit({ type: "session_before_fork", entryId, position: "at" as const });
				if (hookResult?.cancel === true) throw new Error("Fork was cancelled by an extension");
			}

			// createBranchedSession mutates its SessionManager. Always use an
			// independent manager so the source runtime remains bound to A.
			const forkManager = SessionManager.open(sourceFile, sourceSession.sessionManager.getSessionDir());
			let forkedPath: string | undefined;
			let forkedSessionId: string | undefined;
			try {
				forkedPath = forkManager.createBranchedSession(entryId);
				if (!forkedPath) throw new Error("Failed to create forked session");
				forkedSessionId = forkManager.getSessionId();
				const forkedManaged = await this.createManagedRuntime(
					forkManager.getCwd(),
					forkManager,
					managed.projectId,
					Date.now(),
					{ type: "session_start", reason: "fork", previousSessionFile: sourceFile },
				);
				const session = forkedManaged.runtime.session;
				if (opts?.name?.trim()) session.setSessionName(opts.name.trim().slice(0, MAX_NAME_LENGTH));
				// Fork 出的新 session：若没有指定名字，也加入"刚创建默认名"集合。
				if (!opts?.name?.trim()) {
					const forkScope = this.scopeRegistry.get(session.sessionId);
					if (forkScope) forkScope.isDefaultName = true;
				}
				if (!session.sessionFile) throw new Error("Forked session was not persisted");
				await this.refreshProjectSessions(managed.projectId);
				this.projectService.setActiveId(managed.projectId);
				this.activeSessionId = session.sessionId;
				this.emitSessionState(session.sessionId, "initial");
				return { agentId: session.sessionId, sessionFilePath: session.sessionFile };
			} catch (error) {
				if (forkedSessionId && this.runtimes.has(forkedSessionId)) await this.disposeRuntime(forkedSessionId, true);
				if (forkedPath && existsSync(forkedPath)) fs.unlinkSync(forkedPath);
				throw error;
			}
		});
	}

	private async withForkLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.forkOperationTails.get(sessionId) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => gate);
		this.forkOperationTails.set(sessionId, tail);
		await previous;
		try {
			return await task();
		} finally {
			release();
			if (this.forkOperationTails.get(sessionId) === tail) this.forkOperationTails.delete(sessionId);
		}
	}

	setEntryLabel(sessionId: string, entryId: string, label: string | null): void {
		const manager = this.sessionManagerFor(sessionId);
		if (!manager) return;
		const leaf = manager.getLeafId();
		manager.appendLabelChange(entryId, label?.trim() || undefined);
		if (leaf) manager.branch(leaf);
		else manager.resetLeaf();
		this.emitSessionState(sessionId, "navigate");
	}

	/**
	 * 首条 user 消息 message_end 事件时调用。
	 * 仅在 scope.isDefaultName 为 true 的 session 触发，
	 * 把决策权完全交给 Service 内部的并发 / abort / generated 守卫。
	 */
	private async onUserMessageEndForTitle(sessionId: string, userMsg: AgentMessage): Promise<void> {
		const managed = this.runtimes.get(sessionId);
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
			this.trackSubSessionMessageEnd(sessionId, message);
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
			this.finalizeSubSession(sessionId);
		}
	}

	// ── SDK event entry point (delegated to SessionEventProcessor) ──

	private handleSessionEvent(sessionId: string, event: AgentSessionEvent): void {
		this.eventProcessor.handle(sessionId, event);
	}

	// ── UI event batching (delegated to UIEventBatcher) ──

	private bufferUiEvents(sessionId: string, events: LookUiEvent[]): void {
		const scope = this.scopeRegistry.get(sessionId);
		if (scope) this.uiBatcher.bufferUiEvents(scope, events);
	}

	private clearUiEventBuffer(scope: ISessionScope): void {
		this.uiBatcher.clearUiEventBuffer(scope);
	}

	private flushUiEventBuffer(scope: ISessionScope): void {
		this.uiBatcher.flushUiEventBuffer(scope);
	}

	private async refreshAfterTurn(sessionId: string): Promise<void> {
		const projectId = this.runtimes.get(sessionId)?.projectId ?? this.findStoredSession(sessionId)?.projectId;
		if (!projectId) return;
		await this.refreshProjectSessions(projectId);
		this.emitSessionUpdated(sessionId);
		this.emitSessionList(projectId);
	}

	// ISessionEventHost — public for interface compatibility
	emitSessionState(targetSessionId?: string, reason: string = "activate"): void {
		const sessionId = targetSessionId ?? this.activeSessionId;
		if (!sessionId) return;
		const managed = this.runtimes.get(sessionId);
		const projectId = managed?.projectId ?? this.findStoredSession(sessionId)?.projectId;
		if (projectId) this.emitSessionList(projectId);
		if (managed) {
			const session = managed.runtime.session;
			this.emit({
				type: "session:snapshot",
				sessionId,
				reason: reason as SessionSnapshotEnvelope["reason"],
				leafId: session.sessionManager.getLeafId(),
				entries: session.sessionManager.getBranch(),
				runtime: {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: this.isStreaming(sessionId, session.isStreaming),
					isRetrying: session.isRetrying,
					isCompacting: session.isCompacting,
					retryAttempt: session.retryAttempt,
					steering: session.getSteeringMessages(),
					followUp: session.getFollowUpMessages(),
					stats: session.getSessionStats(),
					contextUsage: session.getContextUsage(),
				},
			});
		}
		this.emitSessionUpdated(sessionId);
	}

	/** ISessionEventHost — 每次 tool_execution_end 时检查并推送 TODO.md 进度 */
	emitTodoUpdate(sessionId: string): void {
		const managed = this.runtimes.get(sessionId);
		if (!managed) return;
		const items = parseTodoFile(managed.runtime.cwd);
		// 始终发送事件：items 为 null/空数组时清空渲染端状态
		this.emit({ type: "todo:update", sessionId, items: items ?? [] });
	}

	// ISessionEventHost — public for interface compatibility
	emitSessionUpdated(sessionId: string): void {
		const info = this.getAgentInfo(sessionId);
		if (info) this.emit({ type: "agent:updated", agentId: info.id, agent: info });
	}

	private emitSessionList(projectId: string): void {
		this.emit({ type: "agent:list", projectId, agents: this.listAgentsInProject(projectId) });
	}

	private emitProjectList(): void {
		this.emit({ type: "project:list", projects: this.listProjects(), activeProjectId: this.projectService.activeId });
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
					cost: { input: model.cost?.input ?? 0, output: model.cost?.output ?? 0 },
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
		await this.applyPermissionMode(sessionId, mode, { internal: false, updateDefault: true });
	}

	private async applyPermissionMode(
		sessionId: string,
		mode: PermissionMode,
		options: { internal: boolean; updateDefault: boolean },
	): Promise<void> {
		const managed = await this.ensureRuntime(sessionId);
		const previousMode = this.permissionService.getMode(sessionId);
		if (previousMode === mode) return;

		if (!options.internal) this.planService.cancelInteractions(sessionId, "Permission mode was changed manually");
		if (mode === "plan") this.planService.capturePrePlanTools(sessionId);

		this.permissionService.setMode(sessionId, mode);
		if (mode === "plan") this.planService.restrictToolsForPlan(sessionId);
		else if (previousMode === "plan") this.planService.restorePrePlanTools(sessionId);
		this.permissionService.persistIfDirty(sessionId);
		this.planService.persistToolSnapshotIfDirty(sessionId);

		if (options.updateDefault) {
			this.permissionService.setDefaultMode(mode);
			await this.userSettings.update({ permissionMode: mode });
		}

		if (!options.internal && managed.runtime.session.isStreaming && (previousMode === "plan" || mode === "plan")) {
			await managed.runtime.session.abort();
		}
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
		const session = this.runtimes.get(sessionId)?.runtime.session;
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
			for (const managed of this.runtimes.values()) {
				managed.runtime.session.setAutoCompactionEnabled(partial.compactionEnabled);
			}
		}
		if (partial.permissionMode !== undefined) this.permissionService.setDefaultMode(partial.permissionMode);
		if (partial.subagentEnabled !== undefined) {
			this.subagentDefaultEnabled = partial.subagentEnabled;
			await Promise.all(
				Array.from(this.runtimes.keys()).map((sessionId) =>
					this.applySubagentEnabled(sessionId, partial.subagentEnabled as boolean),
				),
			);
		}
		return settings;
	}

	async resetGeneralSettings(): Promise<UserSettings> {
		const settings = await this.userSettings.reset();
		this.permissionService.setDefaultMode(settings.permissionMode);
		this.subagentDefaultEnabled = settings.subagentEnabled;
		this.globalSettingsManager.setDefaultProjectTrust("ask");
		return settings;
	}

	listSkillsForUI() {
		const activeRuntime = this.activeSessionId ? this.runtimes.get(this.activeSessionId)?.runtime : undefined;
		const skillPaths =
			activeRuntime?.services.settingsManager.getSkillPaths() ?? this.globalSettingsManager.getSkillPaths();
		const loaded = activeRuntime?.services.resourceLoader.getSkills() ?? { skills: [], diagnostics: [] };

		const rawSkills = loaded.skills.length > 0 ? loaded.skills : discoverSkillsFromPaths(skillPaths);
		const skillsWithCategory = (rawSkills as any[]).map((s) => ({
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
			const activeRuntime = this.activeSessionId ? this.runtimes.get(this.activeSessionId)?.runtime : undefined;
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
			await Promise.all(Array.from(this.runtimes.values()).map((managed) => managed.runtime.session.reload()));
			return { success: true, importedCount: merged.length };
		} catch (error) {
			return { success: false, importedCount: 0, error: error instanceof Error ? error.message : String(error) };
		}
	}

	detectCommonSkillPaths() {
		return detectCommonSkillPaths();
	}

	onEvent(callback: EventCallback): () => void {
		this.eventCallbacks.push(callback);
		return () => {
			const index = this.eventCallbacks.indexOf(callback);
			if (index >= 0) this.eventCallbacks.splice(index, 1);
		};
	}

	public emit(event: MainToRendererEvent): void {
		for (const callback of this.eventCallbacks) callback(event);
	}

	private emitError(error: unknown, sessionId?: string): void {
		this.emit({
			type: "error",
			agentId: sessionId ?? this.activeSessionId ?? undefined,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}
