import type {
	AgentDefinitionInfo,
	AgentDefinitionInput,
	AgentInfo,
	AvailableModel,
	CustomProviderInput,
	Draft,
	DraftPatch,
	FileTreeNode,
	GitDiffFile,
	GitRepoInfo,
	ImageContent,
	MainToRendererEvent,
	ProjectInfo,
	ProviderInfo,
	RendererToMainEvent,
	ScheduledTask,
	ScheduledTaskInput,
	ScheduledTaskRunLog,
	ScheduledTaskTestResult,
	SessionHistoryPage,
	TestCustomProviderResult,
	ThinkingLevel,
	UserProfile,
	UserSettings,
} from "../types.js";

/**
 * IPC 边界统一信封。对齐 pi SDK 的领域规范（方法返回业务值、错误 throw），
 * 错误序列化只在 IPC 边界做一次：领域服务 throw → handlers.ts 的
 * `look:invoke` 统一 catch 并产出失败分支（error/errorCode/errorStack）。
 *
 * 成功分支的 `error?: never` 是兼容位：让渲染端 `result?.error ?? fallback`
 * 的无收窄读法继续成立（成功时类型为 undefined），同时保证失败分支必须
 * 携带 error。
 *
 * 注意：失败分支**不携带错误栈**。完整栈（含绝对路径、SDK 内部帧）只写入
 * 主进程日志；渲染端 UI 从不消费栈信息，随 IPC 回传只会放大 XSS 下的信息
 * 泄露面。
 */
export type IpcResult<T extends object = object> =
	| ({ success: true } & T & { error?: never })
	| { success: false; error: string; errorCode?: string | null };

/**
 * Redirect target for Supabase account OAuth (GitHub/Google). Uses the app's
 * custom protocol so the callback never resolves to a real servable page;
 * the main process captures it via navigation events and a protocol handler.
 */
export const OAUTH_REDIRECT_URL = "look://auth/callback";

export interface ProviderSettingsData {
	providers: Array<{
		id: string;
		name: string;
		hasKey: boolean;
		envVar?: string;
		modelsAvailable: number;
		models?: Array<{
			id: string;
			name: string;
			reasoning: boolean;
			contextWindow: number;
			maxTokens: number;
		}>;
		authSource?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
		envLabel?: string;
		hasLogin: boolean;
		supportsApiKey: boolean;
	}>;
	customProviders: CustomProviderInput[];
	customStats: { configured: number; totalModels: number };
}

/**
 * The Look IPC surface injected by preload.js.
 *
 * `window.look` is the canonical renderer API. The previous
 * `HarnessAPI` / `window.harness` codename has been removed.
 */
export interface LookAPI {
	/** User home directory, injected by preload. Used to shorten absolute
	 *  paths to ~/… in tool-call summaries. Empty string if unavailable. */
	homedir: string;
	/** Host platform (`process.platform`), injected by preload. Used for
	 *  macOS-only chrome adjustments (hiddenInset traffic-light clearance). */
	platform: string;
	send(event: RendererToMainEvent): void;
	invoke(event: RendererToMainEvent): Promise<unknown>;
	onEvent(callback: (event: MainToRendererEvent) => void): () => void;

	sendMessage(
		agentId: string,
		message: string,
		images?: ImageContent[],
		sendMode?: "steer" | "followUp",
	): Promise<IpcResult>;
	removeQueuedMessage(agentId: string, text: string): Promise<IpcResult>;
	insertQueuedMessage(agentId: string, text: string): Promise<IpcResult>;
	activateSession(sessionId: string, opts?: { skipSnapshot?: boolean }): Promise<IpcResult>;
	createAgent(
		name?: string | { name?: string; projectId?: string; imProvider?: "feishu" },
	): Promise<IpcResult<{ agentId: string; agent?: AgentInfo }>>;
	destroyAgent(agentId: string): Promise<IpcResult>;
	getModels(): Promise<IpcResult<{ models: AvailableModel[] }>>;
	getProviders(): Promise<IpcResult<{ providers: ProviderInfo[] }>>;
	getAgents(): Promise<IpcResult<{ agents?: AgentInfo[] }>>;
	listScheduledTasks(): Promise<IpcResult<{ tasks: ScheduledTask[] }>>;
	listDrafts(): Promise<IpcResult<{ drafts: Draft[] }>>;
	createDraft(text: string): Promise<IpcResult<{ draft: Draft }>>;
	updateDraft(draftId: string, patch: DraftPatch): Promise<IpcResult<{ draft: Draft }>>;
	deleteDraft(draftId: string): Promise<IpcResult>;
	createScheduledTask(task: ScheduledTaskInput): Promise<IpcResult<{ task: ScheduledTask }>>;
	updateScheduledTask(taskId: string, patch: Partial<ScheduledTaskInput>): Promise<IpcResult<{ task: ScheduledTask }>>;
	startScheduledTask(taskId: string): Promise<IpcResult<{ task: ScheduledTask }>>;
	pauseScheduledTask(taskId: string): Promise<IpcResult<{ task: ScheduledTask }>>;
	resumeScheduledTask(taskId: string): Promise<IpcResult<{ task: ScheduledTask }>>;
	deleteScheduledTask(taskId: string): Promise<IpcResult>;
	runScheduledTaskNow(taskId: string): Promise<IpcResult<{ accepted: true }>>;
	testScheduledTask(task: ScheduledTaskInput, taskId?: string): Promise<IpcResult<ScheduledTaskTestResult>>;
	listScheduledTaskLogs(taskId?: string, limit?: number): Promise<IpcResult<{ logs: ScheduledTaskRunLog[] }>>;
	validateCron(
		cron: string,
		timezone?: string,
	): Promise<IpcResult<{ valid: boolean; error?: string; nextRunAt?: string }>>;
	switchModel(agentId: string, model: string): Promise<IpcResult>;
	updateThinking(agentId: string, level: ThinkingLevel): Promise<IpcResult>;
	abortAgent(agentId: string): Promise<IpcResult>;
	loadHistoryPage(
		sessionId: string,
		beforeEntryId: string | null,
		revision: string,
		limit?: number,
	): Promise<IpcResult<SessionHistoryPage>>;
	setEntryLabel(agentId: string, entryId: string, label: string | null): Promise<IpcResult>;
	renameAgent(agentId: string, name: string): Promise<IpcResult>;
	compressSession(agentId: string, customInstructions?: string): Promise<IpcResult>;
	abortCompressSession(agentId: string): Promise<IpcResult>;
	navigateTree(
		agentId: string,
		entryId: string,
		options?: { summarize?: boolean; customInstructions?: string; label?: string },
	): Promise<IpcResult<{ result: { editorText?: string; cancelled: boolean; aborted?: boolean } }>>;
	createFork(
		agentId: string,
		entryId: string,
		options?: { name?: string },
	): Promise<IpcResult<{ agentId: string; sessionFilePath: string }>>;
	openDirectoryDialog(title?: string): Promise<IpcResult<{ path?: string; canceled?: boolean }>>;
	openFileDialog(options?: {
		title?: string;
		allowDirectories?: boolean;
		allowMultiple?: boolean;
	}): Promise<IpcResult<{ paths?: string[]; canceled?: boolean }>>;
	/** Recover the absolute filesystem path from a File object dropped into
	 *  the sandboxed renderer. Returns null when the File has no recoverable
	 *  path (e.g. dropped directories in HTML5 dataTransfer). */
	getPathForFile(file: unknown): string | null;
	openProjectFolder(projectId?: string): Promise<IpcResult<{ path?: string }>>;
	listProjects(): Promise<IpcResult<{ projects: ProjectInfo[]; activeProjectId?: string | null }>>;
	createProject(cwd: string, name?: string): Promise<IpcResult<{ project: ProjectInfo; isDuplicate: boolean }>>;
	renameProject(projectId: string, name: string): Promise<IpcResult>;
	switchProject(projectId: string): Promise<IpcResult>;
	getActiveProject(): Promise<IpcResult<{ project: ProjectInfo | null }>>;
	getProjectGitInfo(projectId: string): Promise<IpcResult<{ info: GitRepoInfo | null }>>;
	getProjectGitDiff(projectId: string): Promise<IpcResult<{ files: GitDiffFile[] }>>;
	getProjectGitFileHead(projectId: string, absolutePath: string): Promise<IpcResult<{ content: string | null }>>;
	getGitFileHead(absolutePath: string): Promise<IpcResult<{ content: string | null }>>;
	deleteProject(projectId: string): Promise<IpcResult>;
	confirmDeleteProject(projectId: string, confirmed: boolean): Promise<IpcResult>;
	getSettings(): Promise<IpcResult<ProviderSettingsData>>;
	setApiKey(provider: string, key: string): Promise<IpcResult<ProviderSettingsData>>;
	testApiKey(
		provider: string,
		key: string,
	): Promise<
		IpcResult<{ result: { ok?: boolean; skipped?: boolean; status?: number; error?: string; reason?: string } }>
	>;
	getApiKey(
		provider: string,
		opts?: { reveal?: boolean },
	): Promise<IpcResult<{ key: string | null; masked?: boolean }>>;
	testEnvKey(
		provider: string,
	): Promise<
		IpcResult<{ result: { ok?: boolean; skipped?: boolean; status?: number; error?: string; reason?: string } }>
	>;
	addCustomProvider(input: CustomProviderInput): Promise<IpcResult>;
	updateCustomProvider(name: string, patch: Partial<CustomProviderInput>): Promise<IpcResult>;
	removeCustomProvider(name: string): Promise<IpcResult<{ removed: boolean }>>;
	listCustomProviders(): Promise<IpcResult<{ providers: CustomProviderInput[] }>>;
	testCustomProvider(input: CustomProviderInput): Promise<IpcResult<{ result: TestCustomProviderResult }>>;
	getGeneralSettings(): Promise<IpcResult<{ settings?: GeneralSettings }>>;
	setGeneralSettings(settings: Partial<GeneralSettings>): Promise<IpcResult<{ settings?: GeneralSettings }>>;
	resetGeneralSettings(): Promise<IpcResult<{ settings?: GeneralSettings }>>;
	// ---- v0.3 skills ----
	listSkills(): Promise<
		IpcResult<{ skills?: SkillEntry[]; diagnostics?: SkillDiagnostic[]; importedPaths?: string[] }>
	>;
	importSkillPaths(paths: string[]): Promise<IpcResult<{ importedCount: number }>>;
	detectCommonSkillPaths(): Promise<
		IpcResult<{ detected?: Array<{ tool: string; path: string; exists: boolean; skillCount: number }> }>
	>;
	setPermissionMode(
		agentId: string,
		mode: "always" | "ask" | "plan",
		/** 默认 true：连带更新用户全局默认模式；会话内临时提升传 false */
		updateDefault?: boolean,
	): Promise<IpcResult<{ mode?: "always" | "ask" | "plan" }>>;
	getPermissionMode(agentId: string): Promise<IpcResult<{ mode?: "always" | "ask" | "plan" }>>;
	respondPermission(payload: { requestId: string; action: "allow" | "deny" | "allow_always" }): Promise<IpcResult>;
	respondPlanQuestion(payload: {
		requestId: string;
		sessionId: string;
		answers: Record<string, string>;
		cancelled?: boolean;
	}): Promise<IpcResult>;
	respondPlanApproval(payload: {
		requestId: string;
		sessionId: string;
		action: "approve" | "reject";
	}): Promise<IpcResult>;
	// ---- SubAgent：子会话关系查询（Stage 4 嵌套） ----
	listSubSessions(parentSessionId: string): Promise<IpcResult<{ childSessionIds?: string[] }>>;
	getParentSession(childSessionId: string): Promise<IpcResult<{ parentSessionId?: string | null }>>;
	/** 查找父会话已有的审核子会话（防重复）；未命中由渲染端注入 /subagent:reviewer 委派指令。 */
	reviewChanges(payload: {
		parentSessionId: string;
		title: string;
		turnKey: string;
	}): Promise<IpcResult<{ childSessionId: string | null; title: string }>>;
	// ---- SubAgent：Agent 定义 CRUD（Stage 3 广场） ----
	listAgentDefinitions(): Promise<IpcResult<{ agents?: AgentDefinitionInfo[] }>>;
	createAgentDefinition(input: AgentDefinitionInput): Promise<IpcResult<{ agent?: AgentDefinitionInfo }>>;
	updateAgentDefinition(
		name: string,
		input: AgentDefinitionInput,
	): Promise<IpcResult<{ agent?: AgentDefinitionInfo }>>;
	deleteAgentDefinition(name: string): Promise<IpcResult>;
	installAgentDefinition(name: string): Promise<IpcResult<{ agent?: AgentDefinitionInfo }>>;
	// ---- SubAgent：Agent 开关（Stage 2） ----
	setSubagentEnabled(enabled: boolean): Promise<IpcResult<{ enabled?: boolean }>>;
	// ---- SubAgent：Agent 定义开关 ----
	setAgentDefinitionEnabled(name: string, enabled: boolean): Promise<IpcResult>;
	// ---- Skills：Skill 开关 ----
	setSkillEnabled(name: string, enabled: boolean): Promise<IpcResult>;
	revealInFinder(path: string): Promise<IpcResult>;
	/** Open an OAuth URL in a controlled browser window, returns the final redirect URL. */
	openOAuthUrl(url: string, redirectTo: string): Promise<IpcResult<{ redirectUrl: string }>>;
	getUserProfile(): Promise<IpcResult<{ profile: UserProfile | null }>>;
	updateUserProfile(
		patch: Partial<{ userId: string; email: string; userName: string; avatar: string }>,
	): Promise<IpcResult>;
	resetUserProfile(): Promise<IpcResult>;
	logout(): Promise<IpcResult>;
	// ---- Shared area ----
	listSharedFiles(projectId: string): Promise<IpcResult<{ nodes?: FileTreeNode[] }>>;
	listSharedChildren(projectId: string, relativePath: string): Promise<IpcResult<{ nodes?: FileTreeNode[] }>>;
	startSharedWatch(projectId: string): Promise<IpcResult>;
	stopSharedWatch(projectId: string): Promise<IpcResult>;
	writeSharedFile(projectId: string, path: string, content: string): Promise<IpcResult>;
	createSharedDir(projectId: string, path: string): Promise<IpcResult>;
	deleteSharedItem(projectId: string, path: string): Promise<IpcResult>;
	importToShared(projectId: string, sources: string[], targetDir?: string): Promise<IpcResult>;
	exportFromShared(projectId: string, paths: string[], destDir: string): Promise<IpcResult>;
	/** Drag-drop fallback: write base64/utf8 content to shared area when
	 *  absolute path is unavailable. */
	writeSharedContent(
		projectId: string,
		path: string,
		content: string,
		encoding?: "base64" | "utf8",
	): Promise<IpcResult>;
	// ---- Workspace tree (v0.6) ----
	listWorkspaceChildren(
		projectId: string,
		relativePath: string,
		showHiddenFiles?: boolean,
	): Promise<IpcResult<{ nodes?: FileTreeNode[] }>>;
	statWorkspaceNode(projectId: string, relativePath: string): Promise<IpcResult<{ node?: FileTreeNode | null }>>;
	startWorkspaceWatch(projectId: string, relativePath: string): Promise<IpcResult>;
	stopWorkspaceWatch(projectId: string, relativePath: string): Promise<IpcResult>;
	// ---- File content ----
	readFileContent(
		path: string,
	): Promise<
		IpcResult<
			| { kind: "text"; content: string; truncated: boolean; sizeBytes: number; inProject: boolean }
			| { kind: "image"; data: string; mimeType: string; sizeBytes: number; inProject: boolean }
			| { kind: "binary"; sizeBytes: number; inProject: boolean }
		>
	>;
	writeFileContent(path: string, content: string): Promise<IpcResult<{ sizeBytes: number }>>;
	statFilePath(
		path: string,
	): Promise<IpcResult<{ kind: "file" | "directory" | "other" | "missing"; inProject: boolean }>>;
	// ---- File viewer window ----
	/** 在独立查看器窗口中打开文件；diffPatch 随窗口传递（undock 时保留 diff 语义）。 */
	openFileViewer(path: string, fadeIn?: boolean, diffPatch?: string): Promise<IpcResult>;
	/** 独立查看器窗口请求合并到主窗口右侧 Dock 面板；diffPatch 随合并事件带回。 */
	dockFileViewer(path: string, diffPatch?: string): Promise<IpcResult>;
	/** 主窗口对 fileViewer:docked 合并请求的回执：confirmed=true 才关闭独立窗口，取消时保持窗口打开。 */
	resolveFileViewerDock(confirmed: boolean): Promise<IpcResult>;
	fileViewerReady(): Promise<IpcResult<{ path?: string | null; diffPatch?: string | null }>>;
	// ---- IM Channels ----
	getImChannels(): Promise<
		IpcResult<{
			channels?: Array<{
				provider: string;
				appId: string;
				name?: string;
				status: string;
				connected: boolean;
				enabled: boolean;
				error?: string;
			}>;
		}>
	>;
	getImBindings(): Promise<
		IpcResult<{
			bindings?: Array<{
				chatId: string;
				sessionId: string;
				projectId: string;
				createdAt: number;
				appId?: string;
				chatType?: "p2p" | "group";
				senderOpenId?: string;
				peerName?: string;
			}>;
		}>
	>;
	connectFeishuChannel(options?: {
		appName?: string;
		description?: string;
	}): Promise<IpcResult<{ registrationId?: string }>>;
	connectFeishuManualChannel(input: { appId: string; appSecret: string; name?: string }): Promise<IpcResult>;
	cancelFeishuRegistration(registrationId: string): Promise<IpcResult>;
	disconnectImChannel(provider: string, appId?: string): Promise<IpcResult>;
	removeImChannel(provider: string, appId: string): Promise<IpcResult>;
	reconnectImChannel(provider: string, appId: string): Promise<IpcResult>;
	sendImTestMessage(input: { receiveIdType: string; receiveId: string; text: string }): Promise<IpcResult>;
	testImConnection(appId: string): Promise<IpcResult<{ message?: string }>>;
	testImConnectionDirect(appId: string, appSecret: string): Promise<IpcResult<{ message?: string }>>;
	updateImChannel(appId: string, updates: { name?: string }): Promise<IpcResult>;
	// ---- Provider OAuth login ----
	/** Initiate an OAuth login flow for a provider (e.g. OpenRouter, Kimi Code). */
	providerLogin(provider: string): Promise<IpcResult<ProviderSettingsData>>;
	/** Respond to an interactive login prompt from the main process. */
	respondLoginPrompt(promptId: string, value: string): Promise<IpcResult>;
	/** Cancel an interactive login prompt. */
	cancelLoginPrompt(promptId: string): Promise<IpcResult>;
	/** Log out / clear stored credentials for a provider. */
	providerLogout(provider: string): Promise<IpcResult<ProviderSettingsData>>;

	// ---- MCP tools ----
	listAllMcpTools(): Promise<
		IpcResult<{ tools?: Array<{ server: string; tool: { name: string; description?: string } }> }>
	>;
	// ---- Usage ----
	getUsage(): Promise<IpcResult<{ usage: unknown }>>;
	listPrompts(): Promise<IpcResult<{ prompts: unknown[] }>>;
	createPrompt(name: string, content: string): Promise<IpcResult>;
	updatePrompt(id: string, patch: Record<string, unknown>): Promise<IpcResult>;
	deletePrompt(id: string): Promise<IpcResult>;
	setActivePrompt(id: string): Promise<IpcResult>;
	listProjectPrompts(projectId: string): Promise<IpcResult<{ prompts: unknown[] }>>;
	createProjectPrompt(projectId: string, name: string, content: string): Promise<IpcResult>;
	updateProjectPrompt(projectId: string, id: string, patch: Record<string, unknown>): Promise<IpcResult>;
	deleteProjectPrompt(projectId: string, id: string): Promise<IpcResult>;
	setProjectActivePrompt(projectId: string, id: string): Promise<IpcResult>;
	listMcpServers(): Promise<IpcResult<{ servers: unknown[] }>>;
	listMcpTools(name: string): Promise<IpcResult<{ tools: unknown[] }>>;
	addMcpServer(config: Record<string, unknown>): Promise<IpcResult>;
	removeMcpServer(name: string): Promise<IpcResult>;
	testMcpServer(name: string): Promise<IpcResult<{ tools: unknown[]; error?: string }>>;
	toggleMcpServer(name: string, enabled: boolean): Promise<IpcResult>;
	updateMcpServer(name: string, config: Record<string, unknown>): Promise<IpcResult>;

	// ---- Auto Updater ----
	// 状态变化通过 onEvent 的 "update:status" 事件推送（AppUpdatePhase）
	checkForUpdates(): Promise<IpcResult>;
	downloadUpdate(): Promise<IpcResult>;
	installUpdate(): Promise<IpcResult>;
}

interface SkillEntry {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	source: "user" | "project" | "path";
	disableModelInvocation: boolean;
	category: "builtin" | "mine";
}

interface SkillDiagnostic {
	type: "warning" | "collision";
	message: string;
	path?: string;
}

type GeneralSettings = UserSettings;
