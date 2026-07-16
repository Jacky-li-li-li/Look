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
import type { IEventBus, IRuntimeLifecycle } from "../core/contracts.js";
import type { AgentConfig, SubagentProgress, SubagentResult } from "../extensions/subagent/types.js";
import type { ISessionEventHost } from "../session/event-processor.js";
import type { UserSettings } from "../settings/store.js";
import type { WorkspaceFileService } from "../workspace/workspace-file-service.js";
import type { WorkspaceTreeService } from "../workspace/workspace-tree-service.js";
import { RuntimeManagerComposition } from "./runtime-manager-composition.js";
import type { StoredSession } from "./session-catalog.js";

export type { EventCallback };

/**
 * Hosts independent pi AgentSessionRuntime instances for sessions that are
 * selected or currently running. Each runtime still owns exactly one active pi
 * session; Look only supplies the cross-session registry and event routing.
 *
 * Implements IEventBus so domain services can depend on abstractions instead
 * of the concrete SRT class.
 */
export class SessionRuntimeManager implements IEventBus, IRuntimeLifecycle, ISessionEventHost {
	private readonly composition: RuntimeManagerComposition;
	private disposed = false;

	private get activeSessionId(): string | null {
		return this.composition.activeSessionSelection.currentId;
	}

	private set activeSessionId(sessionId: string | null) {
		this.composition.activeSessionSelection.setCurrent(sessionId);
	}

	constructor(workspaceFileService?: WorkspaceFileService, workspaceTreeService?: WorkspaceTreeService) {
		this.composition = new RuntimeManagerComposition(
			this,
			workspaceFileService ?? null,
			workspaceTreeService ?? null,
		);
	}

	get authStorage() {
		return this.composition.authStorage;
	}

	get modelRegistry() {
		return this.composition.modelRegistry;
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

	private get eventBus() {
		return this.composition.eventBus;
	}

	private get sessionCatalog() {
		return this.composition.sessionCatalog;
	}

	private get projectService() {
		return this.composition.projectService;
	}

	private get userSettings() {
		return this.composition.userSettings;
	}

	private get runtimeRegistry() {
		return this.composition.runtimeRegistry;
	}

	private get sessionControlService() {
		return this.composition.sessionControlService;
	}

	private get sessionHistoryService() {
		return this.composition.sessionHistoryService;
	}

	private get sessionNotifier() {
		return this.composition.sessionNotifier;
	}

	private get sessionInfoService() {
		return this.composition.sessionInfoService;
	}

	private get projectDeletionService() {
		return this.composition.projectDeletionService;
	}

	private get sessionSubagentService() {
		return this.composition.sessionSubagentService;
	}

	private get sessionMessagingService() {
		return this.composition.sessionMessagingService;
	}

	private get sessionPermissionOrchestrator() {
		return this.composition.sessionPermissionOrchestrator;
	}

	private get projectRuntimeService() {
		return this.composition.projectRuntimeService;
	}

	private get sessionLifecycleService() {
		return this.composition.sessionLifecycleService;
	}

	private get runtimeLifecycle() {
		return this.composition.runtimeLifecycle;
	}

	private get sessionEventEffects() {
		return this.composition.sessionEventEffects;
	}

	private get sessionSettingsService() {
		return this.composition.sessionSettingsService;
	}

	private get skillManagementService() {
		return this.composition.skillManagementService;
	}

	private get agentDefinitionService() {
		return this.composition.agentDefinitionService;
	}

	private get permissionService() {
		return this.composition.permissionService;
	}

	private get planService() {
		return this.composition.planService;
	}

	private get subAgentRegistry() {
		return this.composition.subAgentRegistry;
	}

	private get subAgentRuntimeService() {
		return this.composition.subAgentRuntimeService;
	}

	private get workspaceFileService() {
		return this.composition.workspaceFileService;
	}

	private get workspaceTreeService() {
		return this.composition.workspaceTreeService;
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

	/** O(1) lookup by id. */
	getProjectInfo(projectId: string): ProjectInfo | null {
		return this.projectService.getProjectInfo(projectId);
	}

	/** Allows the owner to wire the scheduler service after both objects are created. */
	setSchedulerService(schedulerService: import("../scheduler/scheduler-service.js").SchedulerService): void {
		this.composition.setSchedulerService(schedulerService);
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
		this.sessionEventEffects.dispose();
		this.sessionCatalog.clear();
		this.sessionNotifier.clear();
		this.eventBus.clear();
	}

	async loadProjects(): Promise<ProjectInfo[]> {
		return this.projectService.loadProjects();
	}

	async recoverOrphanedProjects(): Promise<boolean> {
		return this.projectService.recoverOrphanedProjects();
	}

	async restoreWorkspace(): Promise<number> {
		const settings = this.userSettings.getAll();
		const preferredProject = this.projectService.getProjectInfo(settings.lastActiveProjectId);
		const activeProject = preferredProject?.valid ? preferredProject : this.listProjects().find((p) => p.valid);

		// 并发扫描所有项目，但每个项目扫描完成后立即推送 agent:list，
		// 让侧边栏会话列表可以逐项目渲染，而不必等全部扫描结束。
		let total = 0;
		const scanPromises: Promise<void>[] = [];
		for (const project of this.projectService.listProjects()) {
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

		this.projectService.setActiveId(activeProject.id);
		// 立即确定 preferred session ID（不 init runtime），让 renderer 在首帧就
		// 高亮对应 tab 避免 EmptySessionState 闪烁。runtime 由 _autoSelectAgent
		// 或用户点击异步激活。
		const sessions = this.sessionCatalog.listByProject(activeProject.id);
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
		return this.runtimeRegistry.get(sessionId)?.binding.sessionManager;
	}

	getCwd(sessionId: string): string {
		const managed = this.runtimeRegistry.get(sessionId);
		if (!managed) throw new Error(`Session ${sessionId} is not live`);
		return managed.cwd;
	}

	/** Get the stored session file path, even for non-live sessions. */
	getStoredSessionPath(sessionId: string): string | undefined {
		return this.findStoredSession(sessionId)?.path;
	}

	/** Get the cwd for a session (live or stored). */
	getSessionCwd(sessionId: string): string {
		const managed = this.runtimeRegistry.get(sessionId);
		if (managed) return managed.cwd;
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

	async disposeRuntime(sessionId: string, abort = false): Promise<void> {
		return this.runtimeLifecycle.disposeRuntime(sessionId, abort);
	}

	async disposeAllRuntimes(): Promise<void> {
		return this.runtimeLifecycle.disposeAllRuntimes();
	}

	async activateSession(sessionId: string): Promise<void> {
		return this.runtimeLifecycle.activateSession(sessionId);
	}

	async createAgent(
		opts?: { name?: string; projectId?: string; imProvider?: ImSessionProvider; background?: boolean } | string,
	): Promise<string> {
		return this.sessionLifecycleService.createAgent(opts);
	}

	async destroyAgent(sessionId: string): Promise<void> {
		return this.sessionLifecycleService.destroyAgent(sessionId);
	}

	async abortAgent(sessionId: string): Promise<void> {
		return this.sessionLifecycleService.abortAgent(sessionId);
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
		return this.skillManagementService.setEnabled(name, enabled);
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

	// ── ISessionEventHost implementation ──

	async onAgentEnd(sessionId: string, _willRetry: boolean): Promise<void> {
		return this.sessionEventEffects.onAgentEnd(sessionId);
	}

	async onMessageEnd(sessionId: string, message: AgentMessage): Promise<void> {
		return this.sessionEventEffects.onMessageEnd(sessionId, message);
	}

	onSubSessionAgentEnd(sessionId: string): void {
		this.sessionEventEffects.onSubSessionAgentEnd(sessionId);
	}

	// ISessionEventHost — public for interface compatibility
	emitSessionState(
		targetSessionId?: string,
		reason: SessionSnapshotEnvelope["reason"] = "activate",
		willRetry?: boolean,
	): void {
		this.sessionNotifier.emitSessionState(targetSessionId ?? this.activeSessionId, reason, willRetry);
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

	getPermissionMode(sessionId: string): PermissionMode {
		return this.permissionService.getMode(sessionId);
	}

	async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
		return this.sessionPermissionOrchestrator.applyMode(sessionId, mode, {
			internal: false,
			updateDefault: true,
		});
	}

	/** Configure an unattended internal session without changing the user's default permission mode. */
	async setInternalPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
		return this.sessionPermissionOrchestrator.applyMode(sessionId, mode, {
			internal: true,
			updateDefault: false,
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

	getGeneralSettings(): UserSettings {
		return this.sessionSettingsService.get();
	}

	async updateGeneralSettings(partial: Partial<UserSettings>): Promise<UserSettings> {
		return this.sessionSettingsService.update(partial);
	}

	async resetGeneralSettings(): Promise<UserSettings> {
		return this.sessionSettingsService.reset();
	}

	listSkillsForUI() {
		return this.skillManagementService.listForUI();
	}

	async importSkillPaths(paths: string[]): Promise<{ success: boolean; importedCount: number; error?: string }> {
		return this.skillManagementService.importPaths(paths);
	}

	detectCommonSkillPaths() {
		return this.skillManagementService.detectCommonPaths();
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
