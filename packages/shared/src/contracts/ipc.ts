import type {
	AgentDefinitionInfo,
	AgentDefinitionInput,
	AgentInfo,
	AttachmentRef,
	AvailableModel,
	BrowserPanelAction,
	BrowserPanelState,
	BrowserViewLayout,
	CustomProviderInput,
	Draft,
	DraftPatch,
	FileTreeNode,
	GitDiffFile,
	GitRepoInfo,
	ImageContent,
	MainToRendererEvent,
	McpServerStatusEntry,
	McpToolDto,
	McpToolWithServer,
	PendingAttachment,
	ProjectInfo,
	ProjectPromptDataDto,
	PromptEntry,
	RendererToMainEvent,
	ScheduledTask,
	ScheduledTaskInput,
	ScheduledTaskRunLog,
	ScheduledTaskTestResult,
	SessionHistoryPage,
	SkillDiagnostic,
	SkillEntry,
	TestCustomProviderResult,
	ThinkingLevel,
	UsageData,
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
	invoke(event: RendererToMainEvent): Promise<unknown>;
	onEvent(callback: (event: MainToRendererEvent) => void): () => void;

	/** 返回 queued=true 表示 runtime 未就绪、消息已挂起，绑定后自动发出（意图先行）。 */
	sendMessage(
		agentId: string,
		message: string,
		images?: ImageContent[],
		attachments?: AttachmentRef[],
		sendMode?: "steer" | "followUp",
	): Promise<IpcResult<{ queued: boolean }>>;
	removeQueuedMessage(agentId: string, text: string): Promise<IpcResult>;
	insertQueuedMessage(agentId: string, text: string): Promise<IpcResult>;
	activateSession(sessionId: string, opts?: { skipSnapshot?: boolean }): Promise<IpcResult>;
	createAgent(
		name?: string | { name?: string; projectId?: string; imProvider?: "feishu" },
	): Promise<IpcResult<{ agentId: string; agent?: AgentInfo }>>;
	destroyAgent(agentId: string): Promise<IpcResult>;
	getModels(): Promise<IpcResult<{ models: AvailableModel[] }>>;
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
	deleteScheduledTask(taskId: string): Promise<IpcResult>;
	runScheduledTaskNow(taskId: string): Promise<IpcResult<{ accepted: true }>>;
	testScheduledTask(task: ScheduledTaskInput, taskId?: string): Promise<IpcResult<ScheduledTaskTestResult>>;
	listScheduledTaskLogs(taskId?: string, limit?: number): Promise<IpcResult<{ logs: ScheduledTaskRunLog[] }>>;
	switchModel(agentId: string, model: string): Promise<IpcResult>;
	updateThinking(agentId: string, level: ThinkingLevel): Promise<IpcResult>;
	abortAgent(agentId: string): Promise<IpcResult>;
	loadHistoryPage(
		sessionId: string,
		beforeEntryId: string | null,
		revision: string,
		limit?: number,
	): Promise<IpcResult<SessionHistoryPage>>;
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
	/** macOS：渲染端实测顶部栏可视中心（CSS px）后回传，主进程校正
	 *  hiddenInset 红绿灯垂直位置（换算见 main/system/traffic-light.ts）。 */
	setTrafficLightCenter(centerCssPx: number): Promise<IpcResult>;
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
	addCustomProvider(input: CustomProviderInput): Promise<IpcResult>;
	updateCustomProvider(name: string, patch: Partial<CustomProviderInput>): Promise<IpcResult>;
	removeCustomProvider(name: string): Promise<IpcResult<{ removed: boolean }>>;
	listCustomProviders(): Promise<IpcResult<{ providers: CustomProviderInput[] }>>;
	testCustomProvider(input: CustomProviderInput): Promise<IpcResult<{ result: TestCustomProviderResult }>>;
	getGeneralSettings(): Promise<IpcResult<{ settings?: GeneralSettings }>>;
	setGeneralSettings(settings: Partial<GeneralSettings>): Promise<IpcResult<{ settings?: GeneralSettings }>>;
	// ---- 语音助手（本地转写）----
	transcribeGetState(): Promise<IpcResult<{ state: TranscribeState }>>;
	transcribeSetSettings(patch: TranscribeSettingsPatch): Promise<IpcResult<{ settings: TranscribeSettingsDto }>>;
	transcribeDownloadModel(modelId: string): Promise<IpcResult<{ ok: boolean }>>;
	transcribeDeleteModel(modelId: string): Promise<IpcResult<{ ok: boolean }>>;
	transcribeRecordStart(): Promise<IpcResult<{ ok: boolean }>>;
	transcribeRecordStop(): Promise<IpcResult<{ text: string; seconds: number }>>;
	transcribeRecordState(): Promise<
		IpcResult<{ recording: boolean; rms: number; streaming: boolean; committed: string; tentative: string }>
	>;
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
	// ---- SubAgent：审核子会话 ----
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
	// ---- Paste attachments (LOOK_HOME/attachments/<projectId>/<sessionId>/<name>) ----
	/** 创建（或覆盖同名）粘贴附件，返回完整元数据。 */
	createAttachment(
		projectId: string,
		sessionId: string,
		name: string,
		content: string,
	): Promise<IpcResult<{ attachment: PendingAttachment }>>;
	readAttachment(
		projectId: string,
		sessionId: string,
		name: string,
	): Promise<IpcResult<{ content: string; sizeBytes: number }>>;
	updateAttachment(
		projectId: string,
		sessionId: string,
		name: string,
		content: string,
	): Promise<IpcResult<{ sizeBytes: number }>>;
	deleteAttachment(projectId: string, sessionId: string, name: string): Promise<IpcResult>;
	/** 解析附件绝对路径（历史消息附件卡片打开查看器用）；文件不存在时返回 error。 */
	resolveAttachmentPath(projectId: string, sessionId: string, name: string): Promise<IpcResult<{ path: string }>>;
	/** 从本地路径按字节导入附件（音视频等二进制文件原样拷贝，不做文本解码损坏字节）。 */
	importAttachment(
		projectId: string,
		sessionId: string,
		name: string,
		sourcePath: string,
		mimeType?: string,
	): Promise<IpcResult<{ attachment: PendingAttachment }>>;
	// ---- File viewer window ----
	/** 在独立查看器窗口中打开文件；diffPatch 随窗口传递（undock 时保留 diff 语义）。 */
	openFileViewer(path: string, fadeIn?: boolean, diffPatch?: string): Promise<IpcResult>;
	/** 独立查看器窗口请求合并到主窗口右侧 Dock 面板；diffPatch 随合并事件带回。 */
	dockFileViewer(path: string, diffPatch?: string): Promise<IpcResult>;
	/** 主窗口对 fileViewer:docked 合并请求的回执：confirmed=true 才关闭独立窗口，取消时保持窗口打开。 */
	resolveFileViewerDock(confirmed: boolean): Promise<IpcResult>;
	fileViewerReady(): Promise<IpcResult<{ path?: string | null; diffPatch?: string | null }>>;
	// ---- IM Channels ----
	getImChannels(): Promise<IpcResult<{ channels?: ImChannelEntry[] }>>;
	getImBindings(): Promise<IpcResult<{ bindings?: ImBindingEntry[] }>>;
	connectFeishuChannel(options?: {
		appName?: string;
		description?: string;
	}): Promise<IpcResult<{ registrationId?: string }>>;
	connectFeishuManualChannel(input: { appId: string; appSecret: string; name?: string }): Promise<IpcResult>;
	cancelFeishuRegistration(registrationId: string): Promise<IpcResult>;
	disconnectImChannel(provider: string, appId?: string): Promise<IpcResult>;
	removeImChannel(provider: string, appId: string): Promise<IpcResult>;
	reconnectImChannel(provider: string, appId: string): Promise<IpcResult>;
	testImConnection(appId: string): Promise<IpcResult<{ message?: string }>>;
	testImConnectionDirect(appId: string, appSecret: string): Promise<IpcResult<{ message?: string }>>;
	updateImChannel(appId: string, updates: { name?: string }): Promise<IpcResult>;
	// ---- Built-in browser panel ----
	getBrowserPanelState(): Promise<IpcResult<{ state: BrowserPanelState }>>;
	/** 上报原生浏览器视图布局（renderer BrowserSlot → main WebContentsView setBounds）。 */
	setAgentBrowserLayout(layout: BrowserViewLayout): Promise<IpcResult>;
	browserPanelAction(action: BrowserPanelAction): Promise<IpcResult>;
	/** force=true 时若浏览器未启动则启动一个空白页作为交互目标。 */
	openBrowserPanel(force?: boolean): Promise<IpcResult>;
	/** 关闭面板：回收面板自启（非 agent 持有）的浏览器实例；agent 实例不受影响。 */
	closeBrowserPanel(): Promise<IpcResult>;
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
	listAllMcpTools(): Promise<IpcResult<{ tools?: McpToolWithServer[] }>>;
	// ---- Usage ----
	getUsage(): Promise<IpcResult<{ usage: UsageData }>>;
	listPrompts(): Promise<
		IpcResult<{
			prompts: PromptEntry[];
			activePromptId: string;
			projectOverrides: Record<string, ProjectPromptDataDto>;
		}>
	>;
	createPrompt(name: string, content: string): Promise<IpcResult<{ prompt: PromptEntry }>>;
	updatePrompt(id: string, patch: { name?: string; content?: string }): Promise<IpcResult<{ prompt: PromptEntry }>>;
	deletePrompt(id: string): Promise<IpcResult>;
	setActivePrompt(id: string): Promise<IpcResult>;
	createProjectPrompt(projectId: string, name: string, content: string): Promise<IpcResult<{ prompt: PromptEntry }>>;
	updateProjectPrompt(
		projectId: string,
		id: string,
		patch: { name?: string; content?: string },
	): Promise<IpcResult<{ prompt: PromptEntry }>>;
	deleteProjectPrompt(projectId: string, id: string): Promise<IpcResult>;
	setProjectActivePrompt(projectId: string, id: string): Promise<IpcResult>;
	listMcpServers(): Promise<IpcResult<{ servers: McpServerStatusEntry[] }>>;
	listMcpTools(name: string): Promise<IpcResult<{ tools: McpToolDto[] }>>;
	addMcpServer(config: Record<string, unknown>): Promise<IpcResult>;
	removeMcpServer(name: string): Promise<IpcResult>;
	testMcpServer(name: string): Promise<IpcResult<{ tools?: McpToolDto[] }>>;
	toggleMcpServer(name: string, enabled: boolean): Promise<IpcResult>;
	updateMcpServer(name: string, config: Record<string, unknown>): Promise<IpcResult>;

	// ---- Auto Updater ----
	// 状态变化通过 onEvent 的 "update:status" 事件推送（AppUpdatePhase）
	checkForUpdates(): Promise<IpcResult>;
	downloadUpdate(): Promise<IpcResult>;
	installUpdate(): Promise<IpcResult>;
}

/** IM 渠道条目（getImChannels 载荷元素；invoke-response.ts 复用同一类型）。 */
export interface ImChannelEntry {
	provider: string;
	appId: string;
	name?: string;
	status: string;
	connected: boolean;
	enabled: boolean;
	error?: string;
}

/** IM 绑定条目（getImBindings 载荷元素）。 */
export interface ImBindingEntry {
	chatId: string;
	sessionId: string;
	projectId: string;
	createdAt: number;
	appId?: string;
	chatType?: "p2p" | "group";
	senderOpenId?: string;
	peerName?: string;
}

// ---- 语音助手（本地转写）----

export interface TranscribeModelState {
	id: string;
	name: string;
	size: number;
	cached: boolean;
	downloading: boolean;
	/** 0-100，下载中有效。 */
	progress: number | null;
	/** 模型支持的语言代码列表（含变体，如 zh-CN）。 */
	languages: string[];
	/** 是否支持流式解码。 */
	streaming: boolean;
	/** 差异化亮点（i18n key）。 */
	highlights: string[];
	error?: string;
}

export interface TranscribeSettingsDto {
	modelId: string;
	transcriptionLanguage: string;
	chineseOutput: string;
}

export interface TranscribeSettingsPatch {
	modelId?: string;
	transcriptionLanguage?: string;
	chineseOutput?: "simplified" | "traditional-taiwan" | "traditional-hong-kong";
}

export interface TranscribeState {
	settings: TranscribeSettingsDto;
	models: TranscribeModelState[];
}

type GeneralSettings = UserSettings;
