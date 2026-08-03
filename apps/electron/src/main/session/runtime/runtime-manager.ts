import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
	AgentDefinitionInfo,
	AgentDefinitionInput,
	AgentInfo,
	EventCallback,
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
import type {
	IEventBus,
	IImAgentHost,
	IProjectTrustManager,
	IRuntimeLifecycle,
	ISessionEventHost,
	ISessionRuntimeBootstrap,
	ISubAgentRuntimeHost,
} from "../../core/contracts.js";
import type { AgentConfig, SubagentProgress, SubagentResult } from "../../extensions/subagent/types.js";
import type { UserSettings } from "../../settings/store.js";
import type { WorkspaceFileService } from "../../workspace/workspace-file-service.js";
import type { WorkspaceTreeService } from "../../workspace/workspace-tree-service.js";
import { RuntimeManagerComposition } from "../runtime-manager-composition.js";
import type { StoredSession } from "../services/session-catalog.js";

export type { EventCallback };

/**
 * Hosts independent pi AgentSessionRuntime instances for sessions that are
 * selected or currently running. Each runtime still owns exactly one active pi
 * session; Look only supplies the cross-session registry and event routing.
 *
 * Implements IEventBus so domain services can depend on abstractions instead
 * of the concrete SRT class.
 */
export class SessionRuntimeManager
	implements
		IEventBus,
		IRuntimeLifecycle,
		ISessionEventHost,
		ISubAgentRuntimeHost,
		IProjectTrustManager,
		IImAgentHost,
		ISessionRuntimeBootstrap
{
	/**
	 * Public composition access — used by handlers.ts to populate InvokeContext
	 * and by tests to set up internal state. Replaces the old _getComposition().
	 * Assigned once in the static create() factory.
	 */
	composition!: RuntimeManagerComposition;
	private disposed = false;

	private constructor() {}

	/** Create and initialize a SessionRuntimeManager. Replaces `new SRT()` + `initAsync()`. */
	static async create(
		workspaceFileService?: WorkspaceFileService,
		workspaceTreeService?: WorkspaceTreeService,
	): Promise<SessionRuntimeManager> {
		const srt = new SessionRuntimeManager();
		const composition = await RuntimeManagerComposition.create(
			workspaceFileService ?? null,
			workspaceTreeService ?? null,
		);
		srt.composition = composition;
		return srt;
	}

	// ── Public accessors (kept for external callers not yet migrated) ──

	get modelRuntime() {
		return this.composition.modelRuntime;
	}
	get modelRegistry() {
		return this.composition.modelRegistry;
	}
	get credentialStore() {
		return this.composition.credentialStore;
	}
	get customProviders() {
		return this.composition.customProviders;
	}
	get promptStore() {
		return this.composition.promptStore;
	}
	get mcpManager() {
		return this.composition.mcpManager;
	}

	getWorkspaceFileService(): WorkspaceFileService {
		if (this.disposed) {
			throw new Error("SessionRuntimeManager has been disposed");
		}
		if (!this.composition.workspaceFileService) {
			throw new Error("WorkspaceFileService is not configured for this SessionRuntimeManager");
		}
		return this.composition.workspaceFileService;
	}

	getWorkspaceTreeService(): WorkspaceTreeService {
		if (this.disposed) {
			throw new Error("SessionRuntimeManager has been disposed");
		}
		if (!this.composition.workspaceTreeService) {
			throw new Error("WorkspaceTreeService is not configured for this SessionRuntimeManager");
		}
		return this.composition.workspaceTreeService;
	}

	/** O(1) lookup by id. */
	getProjectInfo(projectId: string): ProjectInfo | null {
		return this.composition.projectService.getProjectInfo(projectId);
	}

	/** Allows the owner to wire the scheduler service after both objects are created. */
	setSchedulerService(schedulerService: import("../../scheduler/scheduler-service.js").SchedulerService): void {
		this.composition.setSchedulerService(schedulerService);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;

		// Access composition services directly — the public getters
		// check `this.disposed` and would throw here.
		const wsFile = this.composition.workspaceFileService;
		const wsTree = this.composition.workspaceTreeService;
		if (wsFile) {
			try {
				await wsFile.dispose();
			} catch (error) {
				console.error("[Look] workspaceFileService dispose failed:", error);
			}
		}
		if (wsTree) {
			try {
				await wsTree.dispose();
			} catch (error) {
				console.error("[Look] workspaceTreeService dispose failed:", error);
			}
		}
		await this.disposeAllRuntimes();
		await this.mcpManager.stopAll();
		this.composition.sessionEventEffects.dispose();
		this.composition.sessionCatalog.clear();
		this.composition.sessionNotifier.clear();
		this.composition.eventBus.clear();
	}

	async loadProjects(): Promise<ProjectInfo[]> {
		return this.composition.projectService.loadProjects();
	}

	async recoverOrphanedProjects(): Promise<boolean> {
		return this.composition.projectService.recoverOrphanedProjects();
	}

	async restoreWorkspace(): Promise<number> {
		const settings = this.composition.userSettings.getAll();
		const preferredProject = this.composition.projectService.getProjectInfo(settings.lastActiveProjectId);
		const activeProject = preferredProject?.valid ? preferredProject : this.listProjects().find((p) => p.valid);

		// 并发扫描所有项目，但每个项目扫描完成后立即推送 agent:list，
		// 让侧边栏会话列表可以逐项目渲染，而不必等全部扫描结束。
		let total = 0;
		const scanPromises: Promise<void>[] = [];
		for (const project of this.composition.projectService.listProjects()) {
			if (!project.valid) continue;
			scanPromises.push(
				this.refreshProjectSessions(project.id).then((sessions) => {
					total += sessions.length;
					this.emitSessionList(project.id);
				}),
			);
		}
		await Promise.all(scanPromises);

		if (!activeProject) return total;

		this.composition.projectService.setActiveId(activeProject.id);
		// 立即确定 preferred session ID（不 init runtime），让 renderer 在首帧就
		// 高亮对应 tab 避免 EmptySessionState 闪烁。runtime 由 _autoSelectAgent
		// 或用户点击异步激活。
		const sessions = this.composition.sessionCatalog.listByProject(activeProject.id);
		const preferred = sessions.find((s) => s.id === settings.lastActiveSessionId) ?? sessions[0];
		if (preferred) this.composition.activeSessionSelection.setCurrent(preferred.id);
		this.emitProjectList();
		return total;
	}

	listProjects(): ProjectInfo[] {
		return this.composition.projectService.listProjects();
	}

	getActiveProject(): ProjectInfo | null {
		return this.composition.projectService.getActiveProject();
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
		return this.composition.runtimeRegistry.get(sessionId)?.runtime;
	}

	getSession(sessionId: string): AgentSession | undefined {
		return this.composition.runtimeRegistry.get(sessionId)?.runtime.session;
	}

	getSessionManager(sessionId: string): SessionManager | undefined {
		return this.composition.runtimeRegistry.get(sessionId)?.binding.sessionManager;
	}

	getCwd(sessionId: string): string {
		const managed = this.composition.runtimeRegistry.get(sessionId);
		if (!managed) throw new Error(`Session ${sessionId} is not live`);
		return managed.cwd;
	}

	/** Get the stored session file path, even for non-live sessions. */
	getStoredSessionPath(sessionId: string): string | undefined {
		return this.findStoredSession(sessionId)?.path;
	}

	/** Get the cwd for a session (live or stored). */
	getSessionCwd(sessionId: string): string {
		const managed = this.composition.runtimeRegistry.get(sessionId);
		if (managed) return managed.cwd;
		const stored = this.findStoredSession(sessionId);
		if (stored) return stored.cwd;
		return this.getProjectRoot();
	}

	/** Check if a sub-session cleanup timer is pending. */
	hasCleanupTimer(sessionId: string): boolean {
		return this.composition.subAgentRuntimeService.hasCleanupTimer(sessionId);
	}

	// ── Project trust ──

	getProjectTrustStatus(projectId: string) {
		return this.composition.projectService.getProjectTrustStatus(projectId);
	}

	async setProjectTrust(projectId: string, trusted: boolean): Promise<void> {
		return this.composition.projectRuntimeService.setProjectTrust(projectId, trusted);
	}

	async createProject(cwd: string, name?: string): Promise<{ project: ProjectInfo; isDuplicate: boolean }> {
		const result = await this.composition.projectRuntimeService.createProject(cwd, name);
		await this.setActiveProject(result.project.id);
		return result;
	}

	async setActiveProject(projectId: string): Promise<void> {
		const project = this.composition.projectService.getProjectInfo(projectId);
		if (!project) throw new Error(`Project ${projectId} not found`);
		this.composition.projectService.setActiveId(projectId);
		if (project.valid) await this.refreshProjectSessions(projectId);
		this.emitProjectList();
		this.emit({ type: "project:active-changed", projectId });
		this.emitSessionList(projectId);
	}

	async executeDeleteProject(projectId: string): Promise<void> {
		return this.composition.projectDeletionService.executeDelete(projectId);
	}

	renameProject(projectId: string, name: string): void {
		if (this.composition.projectService.renameProject(projectId, name)) {
			this.emitProjectList();
		}
	}

	private async refreshProjectSessions(projectId: string): Promise<StoredSession[]> {
		const project = this.composition.projectService.getProjectInfo(projectId);
		if (!project?.valid) return [];
		return this.composition.sessionCatalog.refresh(project);
	}

	private findStoredSession(sessionId: string): StoredSession | undefined {
		return this.composition.sessionCatalog.get(sessionId);
	}

	listAgents(): AgentInfo[] {
		return this.composition.sessionInfoService.listAgents();
	}

	listAgentsInProject(projectId: string): AgentInfo[] {
		return this.composition.sessionInfoService.listAgentsInProject(projectId);
	}

	getAgentInfo(sessionId: string): AgentInfo | undefined {
		return this.composition.sessionInfoService.getAgentInfo(sessionId);
	}

	async disposeRuntime(sessionId: string, abort = false): Promise<void> {
		return this.composition.runtimeLifecycle.disposeRuntime(sessionId, abort);
	}

	async disposeAllRuntimes(): Promise<void> {
		return this.composition.runtimeLifecycle.disposeAllRuntimes();
	}

	async activateSession(sessionId: string, opts?: { skipSnapshot?: boolean }): Promise<void> {
		return this.composition.runtimeLifecycle.activateSession(sessionId, opts);
	}

	async createAgent(
		opts?: { name?: string; projectId?: string; imProvider?: ImSessionProvider; background?: boolean } | string,
	): Promise<string> {
		return this.composition.sessionLifecycleService.createAgent(opts);
	}

	async destroyAgent(sessionId: string): Promise<void> {
		return this.composition.sessionLifecycleService.destroyAgent(sessionId);
	}

	async abortAgent(sessionId: string): Promise<void> {
		return this.composition.sessionLifecycleService.abortAgent(sessionId);
	}

	async sendMessage(sessionId: string, text: string, images?: ImageContent[]): Promise<void> {
		return this.composition.sessionMessagingService.sendMessage(sessionId, text, images);
	}

	// ============================================================
	// SubAgent 子会话生命周期
	// ============================================================

	isSubagentEnabled(sessionId: string): boolean {
		return this.composition.sessionSubagentService.isEnabled(sessionId);
	}

	/**
	 * 全局切换 SubAgent 开关：应用到所有活动会话（动态增删 subagent 工具），
	 * 更新默认值（新会话继承），并持久化到 user-settings。
	 */
	async setSubagentEnabledGlobal(enabled: boolean): Promise<void> {
		return this.composition.sessionSubagentService.setEnabledGlobal(enabled);
	}

	/** 设置单个 Agent 定义的启用状态。 */
	async setAgentDefinitionEnabled(name: string, enabled: boolean): Promise<void> {
		return this.composition.sessionSubagentService.setAgentDefinitionEnabled(name, enabled);
	}

	/** 设置单个 Skill 的启用状态。 */
	async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
		return this.composition.skillManagementService.setEnabled(name, enabled);
	}

	/** Stage 2：切换 Agent 开关。Stage 1 默认 true，此方法为后续阶段预留。 */
	async setSubagentEnabled(sessionId: string, enabled: boolean): Promise<void> {
		return this.composition.sessionSubagentService.setEnabledForSession(sessionId, enabled);
	}

	/** 列出某父会话下的全部子会话 ID。 */
	listSubSessions(parentSessionId: string): string[] {
		return this.composition.subAgentRegistry.listChildren(parentSessionId);
	}

	/** 查询子会话的父会话 ID（无则 null）。 */
	getParentSession(childSessionId: string): string | null {
		return this.composition.subAgentRegistry.getParent(childSessionId);
	}

	// ============================================================
	// SubAgent — Agent 定义 CRUD（委托给 AgentDefinitionService）
	// ============================================================

	async listAgentDefinitions(): Promise<AgentDefinitionInfo[]> {
		return this.composition.agentDefinitionService.listDefinitions();
	}

	async createAgentDefinition(input: AgentDefinitionInput): Promise<AgentDefinitionInfo> {
		return this.composition.agentDefinitionService.createDefinition(input);
	}

	async updateAgentDefinition(name: string, input: AgentDefinitionInput): Promise<AgentDefinitionInfo> {
		return this.composition.agentDefinitionService.updateDefinition(name, input);
	}

	deleteAgentDefinition(name: string): void {
		this.composition.agentDefinitionService.deleteDefinition(name);
	}

	async installAgentDefinition(name: string): Promise<AgentDefinitionInfo> {
		return this.composition.agentDefinitionService.installDefinition(name);
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
		title: string,
		toolCallId: string,
		taskTitle: string,
		onUpdate?: (progress: SubagentProgress) => void,
	): Promise<SubagentResult> {
		return this.composition.sessionSubagentService.runSubSession(
			parentSessionId,
			agent,
			task,
			signal,
			title,
			toolCallId,
			taskTitle,
			onUpdate,
		);
	}

	async setModel(sessionId: string, modelKey: string): Promise<void> {
		await this.composition.sessionControlService.setModel(sessionId, modelKey);
	}

	async setThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<void> {
		await this.composition.sessionControlService.setThinkingLevel(sessionId, level);
	}

	async compressSession(sessionId: string): Promise<void> {
		await this.composition.sessionControlService.compress(sessionId);
	}

	renameAgent(sessionId: string, name: string): void {
		this.composition.sessionControlService.rename(sessionId, name);
	}

	async navigateTreeSession(
		sessionId: string,
		entryId: string,
		opts?: { summarize?: boolean; customInstructions?: string; label?: string },
	): Promise<NavigateTreeResult> {
		return this.composition.sessionHistoryService.navigate(sessionId, entryId, opts);
	}

	async createForkedSession(
		sessionId: string,
		entryId: string,
		opts?: { name?: string },
	): Promise<ForkedSessionResult> {
		return this.composition.sessionHistoryService.fork(sessionId, entryId, opts);
	}

	setEntryLabel(sessionId: string, entryId: string, label: string | null): void {
		this.composition.sessionHistoryService.setEntryLabel(sessionId, entryId, label);
	}

	// ── ISessionEventHost implementation ──

	async onAgentEnd(sessionId: string, willRetry: boolean): Promise<void> {
		return this.composition.sessionEventEffects.onAgentEnd(sessionId, willRetry);
	}

	async onMessageEnd(sessionId: string, message: AgentMessage): Promise<void> {
		return this.composition.sessionEventEffects.onMessageEnd(sessionId, message);
	}

	onSubSessionAgentEnd(sessionId: string): void {
		this.composition.sessionEventEffects.onSubSessionAgentEnd(sessionId);
	}

	// ISessionEventHost — public for interface compatibility
	emitSessionState(
		targetSessionId?: string,
		reason: SessionSnapshotEnvelope["reason"] = "activate",
		willRetry?: boolean,
	): void {
		this.composition.sessionNotifier.emitSessionState(
			targetSessionId ?? this.composition.activeSessionSelection.currentId,
			reason,
			willRetry,
		);
	}

	/** ISessionEventHost — 每次 tool_execution_end 时检查并推送 TODO.md 进度 */
	emitTodoUpdate(sessionId: string): void {
		this.composition.sessionNotifier.emitTodoUpdate(sessionId);
	}

	// ISessionEventHost — public for interface compatibility
	emitSessionUpdated(sessionId: string): void {
		this.composition.sessionNotifier.emitSessionUpdated(sessionId);
	}

	// ISessionEventHost — 流式输出时轻量推送 contextUsage（500ms 节流）
	emitContextUsage(sessionId: string): void {
		this.composition.sessionNotifier.emitContextUsage(sessionId);
	}

	private emitSessionList(projectId: string): void {
		this.composition.sessionNotifier.emitSessionList(projectId);
	}

	private emitProjectList(): void {
		this.composition.sessionNotifier.emitProjectList();
	}

	getPermissionMode(sessionId: string): PermissionMode {
		return this.composition.permissionService.getMode(sessionId);
	}

	async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
		return this.composition.sessionPermissionOrchestrator.applyMode(sessionId, mode, {
			internal: false,
			updateDefault: true,
		});
	}

	/** Configure an unattended internal session without changing the user's default permission mode. */
	async setInternalPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
		return this.composition.sessionPermissionOrchestrator.applyMode(sessionId, mode, {
			internal: true,
			updateDefault: false,
		});
	}

	handlePermissionResponse(payload: PermissionRespondPayload): boolean {
		return this.composition.permissionService.handleResponse(payload);
	}

	handlePlanQuestionResponse(payload: PlanQuestionResponse): boolean {
		return this.composition.planService.handleQuestionResponse(payload);
	}

	async handlePlanApprovalResponse(payload: PlanApprovalResponse): Promise<boolean> {
		return this.composition.planService.handleApprovalResponse(payload);
	}

	getGeneralSettings(): UserSettings {
		return this.composition.sessionSettingsService.get();
	}

	async updateGeneralSettings(partial: Partial<UserSettings>): Promise<UserSettings> {
		return this.composition.sessionSettingsService.update(partial);
	}

	async resetGeneralSettings(): Promise<UserSettings> {
		return this.composition.sessionSettingsService.reset();
	}

	listSkillsForUI() {
		return this.composition.skillManagementService.listForUI();
	}

	async importSkillPaths(paths: string[]): Promise<{ success: boolean; importedCount: number; error?: string }> {
		return this.composition.skillManagementService.importPaths(paths);
	}

	detectCommonSkillPaths() {
		return this.composition.skillManagementService.detectCommonPaths();
	}

	onEvent(callback: EventCallback): () => void {
		return this.composition.eventBus.onEvent(callback);
	}

	public emit(event: MainToRendererEvent): void {
		this.composition.eventBus.emit(event);
	}
}
