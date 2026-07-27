import type {
	AgentDefinitionInfo,
	AgentDefinitionInput,
	AgentInfo,
	AvailableModel,
	CustomProviderInput,
	FileTreeNode,
	ImageContent,
	MainToRendererEvent,
	ProjectInfo,
	ProviderInfo,
	RendererToMainEvent,
	ScheduledTask,
	ScheduledTaskInput,
	ScheduledTaskRunLog,
	ScheduledTaskTestResult,
	TestCustomProviderResult,
	UserProfile,
	UserSettings,
} from "../types.js";

export type IpcResult<T extends object = Record<string, never>> =
	| ({ success: true } & T)
	| { success: false; error: string; errorCode?: string | null; errorStack?: string | null };

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
	activateSession(sessionId: string): Promise<IpcResult>;
	createAgent(
		name?: string | { name?: string; projectId?: string; imProvider?: "feishu" },
	): Promise<IpcResult<{ agentId: string }>>;
	destroyAgent(agentId: string): Promise<IpcResult>;
	getModels(): Promise<IpcResult<{ models: AvailableModel[] }>>;
	getProviders(): Promise<IpcResult<{ providers: ProviderInfo[] }>>;
	getAgents(): Promise<{ success: boolean; agents?: AgentInfo[]; error?: string }>;
	listScheduledTasks(): Promise<IpcResult<{ tasks: ScheduledTask[] }>>;
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
	updateThinking(agentId: string, level: string): Promise<IpcResult>;
	abortAgent(agentId: string): Promise<{ success: boolean; error?: string }>;
	setEntryLabel(agentId: string, entryId: string, label: string | null): Promise<IpcResult>;
	renameAgent(agentId: string, name: string): Promise<IpcResult>;
	compressSession(agentId: string): Promise<IpcResult>;
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
	openDirectoryDialog(
		title?: string,
	): Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>;
	openFileDialog(options?: {
		title?: string;
		allowDirectories?: boolean;
		allowMultiple?: boolean;
	}): Promise<{ success: boolean; paths?: string[]; canceled?: boolean; error?: string }>;
	/** Recover the absolute filesystem path from a File object dropped into
	 *  the sandboxed renderer. Returns null when the File has no recoverable
	 *  path (e.g. dropped directories in HTML5 dataTransfer). */
	getPathForFile(file: unknown): string | null;
	openProjectFolder(projectId?: string): Promise<{ success: boolean; path?: string; error?: string }>;
	listProjects(): Promise<IpcResult<{ projects: ProjectInfo[]; activeProjectId?: string | null }>>;
	createProject(cwd: string, name?: string): Promise<IpcResult<{ project: ProjectInfo; isDuplicate: boolean }>>;
	renameProject(projectId: string, name: string): Promise<IpcResult>;
	switchProject(projectId: string): Promise<IpcResult>;
	getActiveProject(): Promise<IpcResult<{ project: ProjectInfo | null }>>;
	deleteProject(projectId: string): Promise<IpcResult>;
	confirmDeleteProject(projectId: string, confirmed: boolean): Promise<IpcResult>;
	getSettings(): Promise<IpcResult<ProviderSettingsData>>;
	setApiKey(provider: string, key: string): Promise<IpcResult<ProviderSettingsData>>;
	testApiKey(
		provider: string,
		key: string,
	): Promise<{
		success: boolean;
		result: { ok?: boolean; skipped?: boolean; status?: number; error?: string; reason?: string };
	}>;
	getApiKey(provider: string): Promise<IpcResult<{ key: string | null }>>;
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
	getGeneralSettings(): Promise<{ success: boolean; settings?: GeneralSettings; error?: string }>;
	setGeneralSettings(
		settings: Partial<GeneralSettings>,
	): Promise<{ success: boolean; settings?: GeneralSettings; error?: string }>;
	resetGeneralSettings(): Promise<{ success: boolean; settings?: GeneralSettings; error?: string }>;
	// ---- v0.3 skills ----
	listSkills(): Promise<{
		success: boolean;
		skills?: SkillEntry[];
		diagnostics?: SkillDiagnostic[];
		importedPaths?: string[];
		error?: string;
	}>;
	importSkillPaths(paths: string[]): Promise<{ success: boolean; importedCount: number; error?: string }>;
	detectCommonSkillPaths(): Promise<{
		success: boolean;
		detected?: Array<{ tool: string; path: string; exists: boolean; skillCount: number }>;
	}>;
	setPermissionMode(
		agentId: string,
		mode: "always" | "ask" | "plan",
		/** 默认 true：连带更新用户全局默认模式；会话内临时提升传 false */
		updateDefault?: boolean,
	): Promise<{ success: boolean; mode?: "always" | "ask" | "plan"; error?: string }>;
	getPermissionMode(agentId: string): Promise<{ success: boolean; mode?: "always" | "ask" | "plan"; error?: string }>;
	respondPermission(payload: {
		requestId: string;
		action: "allow" | "deny" | "allow_always";
	}): Promise<{ success: boolean; error?: string }>;
	respondPlanQuestion(payload: {
		requestId: string;
		sessionId: string;
		answers: Record<string, string>;
	}): Promise<{ success: boolean; error?: string }>;
	respondPlanApproval(payload: {
		requestId: string;
		sessionId: string;
		action: "approve" | "reject";
	}): Promise<{ success: boolean; error?: string }>;
	// ---- SubAgent：子会话关系查询（Stage 4 嵌套） ----
	listSubSessions(parentSessionId: string): Promise<{ success: boolean; childSessionIds?: string[]; error?: string }>;
	getParentSession(
		childSessionId: string,
	): Promise<{ success: boolean; parentSessionId?: string | null; error?: string }>;
	// ---- SubAgent：Agent 定义 CRUD（Stage 3 广场） ----
	listAgentDefinitions(): Promise<{ success: boolean; agents?: AgentDefinitionInfo[]; error?: string }>;
	createAgentDefinition(
		input: AgentDefinitionInput,
	): Promise<{ success: boolean; agent?: AgentDefinitionInfo; error?: string }>;
	updateAgentDefinition(
		name: string,
		input: AgentDefinitionInput,
	): Promise<{ success: boolean; agent?: AgentDefinitionInfo; error?: string }>;
	deleteAgentDefinition(name: string): Promise<{ success: boolean; error?: string }>;
	installAgentDefinition(name: string): Promise<{ success: boolean; agent?: AgentDefinitionInfo; error?: string }>;
	// ---- SubAgent：Agent 开关（Stage 2） ----
	setSubagentEnabled(enabled: boolean): Promise<{ success: boolean; enabled?: boolean; error?: string }>;
	// ---- SubAgent：Agent 定义开关 ----
	setAgentDefinitionEnabled(name: string, enabled: boolean): Promise<{ success: boolean; error?: string }>;
	// ---- Skills：Skill 开关 ----
	setSkillEnabled(name: string, enabled: boolean): Promise<{ success: boolean; error?: string }>;
	revealInFinder(path: string): Promise<{ success: boolean; error?: string }>;
	/** Open an OAuth URL in a controlled browser window, returns the final redirect URL. */
	openOAuthUrl(url: string, redirectTo: string): Promise<IpcResult<{ redirectUrl: string }>>;
	getUserProfile(): Promise<IpcResult<{ profile: UserProfile | null }>>;
	updateUserProfile(patch: unknown): Promise<IpcResult>;
	resetUserProfile(): Promise<IpcResult>;
	logout(): Promise<IpcResult>;
	// ---- Shared area ----
	listSharedFiles(projectId: string): Promise<{ success: boolean; nodes?: FileTreeNode[]; error?: string }>;
	startSharedWatch(projectId: string): Promise<{ success: boolean; error?: string }>;
	stopSharedWatch(projectId: string): Promise<{ success: boolean; error?: string }>;
	writeSharedFile(projectId: string, path: string, content: string): Promise<{ success: boolean; error?: string }>;
	createSharedDir(projectId: string, path: string): Promise<{ success: boolean; error?: string }>;
	deleteSharedItem(projectId: string, path: string): Promise<{ success: boolean; error?: string }>;
	importToShared(
		projectId: string,
		sources: string[],
		targetDir?: string,
	): Promise<{ success: boolean; error?: string }>;
	exportFromShared(projectId: string, paths: string[], destDir: string): Promise<{ success: boolean; error?: string }>;
	/** Drag-drop fallback: write base64/utf8 content to shared area when
	 *  absolute path is unavailable. */
	writeSharedContent(
		projectId: string,
		path: string,
		content: string,
		encoding?: "base64" | "utf8",
	): Promise<{ success: boolean; error?: string }>;
	// ---- Workspace tree (v0.6) ----
	listWorkspaceChildren(
		projectId: string,
		relativePath: string,
		showHiddenFiles?: boolean,
	): Promise<{ success: boolean; nodes?: FileTreeNode[]; error?: string }>;
	statWorkspaceNode(
		projectId: string,
		relativePath: string,
	): Promise<{ success: boolean; node?: FileTreeNode | null; error?: string }>;
	startWorkspaceWatch(projectId: string, relativePath: string): Promise<{ success: boolean; error?: string }>;
	stopWorkspaceWatch(projectId: string, relativePath: string): Promise<{ success: boolean; error?: string }>;
	// ---- File content ----
	readFileContent(
		path: string,
	): Promise<
		IpcResult<
			| { kind: "text"; content: string; truncated: boolean; sizeBytes: number }
			| { kind: "binary"; sizeBytes: number }
		>
	>;
	writeFileContent(path: string, content: string): Promise<IpcResult<{ sizeBytes: number }>>;
	statFilePath(path: string): Promise<IpcResult<{ kind: "file" | "directory" | "other" | "missing" }>>;
	// ---- File viewer window ----
	openFileViewer(path: string): Promise<{ success: boolean; error?: string }>;
	fileViewerReady(): Promise<{ success: boolean; path?: string | null; error?: string }>;
	// ---- IM Channels ----
	getImChannels(): Promise<{
		success: boolean;
		channels?: Array<{
			provider: string;
			appId: string;
			name?: string;
			status: string;
			connected: boolean;
			enabled: boolean;
			error?: string;
		}>;
		error?: string;
	}>;
	getImBindings(): Promise<{
		success: boolean;
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
		error?: string;
	}>;
	connectFeishuChannel(options?: {
		appName?: string;
		description?: string;
	}): Promise<{ success: boolean; registrationId?: string; error?: string }>;
	connectFeishuManualChannel(input: {
		appId: string;
		appSecret: string;
		name?: string;
	}): Promise<{ success: boolean; error?: string }>;
	cancelFeishuRegistration(registrationId: string): Promise<{ success: boolean; error?: string }>;
	disconnectImChannel(provider: string, appId?: string): Promise<{ success: boolean; error?: string }>;
	removeImChannel(provider: string, appId: string): Promise<{ success: boolean; error?: string }>;
	reconnectImChannel(provider: string, appId: string): Promise<{ success: boolean; error?: string }>;
	sendImTestMessage(input: {
		receiveIdType: string;
		receiveId: string;
		text: string;
	}): Promise<{ success: boolean; error?: string }>;
	testImConnection(appId: string): Promise<{ success: boolean; message?: string; error?: string }>;
	testImConnectionDirect(
		appId: string,
		appSecret: string,
	): Promise<{ success: boolean; message?: string; error?: string }>;
	updateImChannel(appId: string, updates: { name?: string }): Promise<{ success: boolean; error?: string }>;
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
	listAllMcpTools(): Promise<{
		success: boolean;
		tools?: Array<{ server: string; tool: { name: string; description?: string } }>;
		error?: string;
	}>;
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
	addMcpServer(config: unknown): Promise<IpcResult>;
	removeMcpServer(name: string): Promise<IpcResult>;
	testMcpServer(name: string): Promise<IpcResult<{ tools: unknown[]; error?: string }>>;
	toggleMcpServer(name: string, enabled: boolean): Promise<IpcResult>;
	updateMcpServer(name: string, config: unknown): Promise<IpcResult>;

	// ---- Auto Updater ----
	// 状态变化通过 onEvent 的 "update:status" 事件推送（AppUpdatePhase）
	checkForUpdates(): Promise<{ success: boolean; error?: string }>;
	downloadUpdate(): Promise<{ success: boolean; error?: string }>;
	installUpdate(): Promise<{ success: boolean; error?: string }>;
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
