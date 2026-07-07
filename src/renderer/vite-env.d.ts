/// <reference types="vite/client" />

import type {
	AgentDefinitionInfo,
	AgentDefinitionInput,
	AgentInfo,
	FileTreeNode,
	ImageContent,
	ProjectInfo,
} from "@shared/types";
import type { ProviderSettingsData } from "./store/atoms";

type IpcResult<T extends Record<string, unknown> = {}> = ({ success: true } & T) | { success: false; error: string };

/**
 * The Look IPC surface injected by preload.js.
 *
 * `window.look` is the canonical renderer API. The previous
 * `HarnessAPI` / `window.harness` codename has been removed.
 */
interface LookAPI {
	/** User home directory, injected by preload. Used to shorten absolute
	 *  paths to ~/… in tool-call summaries. Empty string if unavailable. */
	homedir: string;
	send(event: unknown): void;
	invoke(event: unknown): Promise<unknown>;
	dequeueMessages(agentId: string): Promise<IpcResult<{ messages: string[] }>>;
	onEvent(callback: (event: unknown) => void): () => void;

	sendMessage(agentId: string, message: string, images?: ImageContent[]): Promise<IpcResult>;
	activateSession(sessionId: string): Promise<IpcResult>;
	createAgent(
		name?: string | { name?: string; projectId?: string; imProvider?: "feishu" },
	): Promise<IpcResult<{ agentId: string }>>;
	destroyAgent(agentId: string): Promise<IpcResult>;
	getModels(): Promise<IpcResult<{ models: AvailableModel[] }>>;
	getProviders(): Promise<IpcResult<{ providers: ProviderInfo[] }>>;
	getAgents(): Promise<{ success: boolean; agents?: AgentInfo[]; error?: string }>;
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
	getPathForFile(file: File): string | null;
	openProjectFolder(projectId?: string): Promise<{ success: boolean; path?: string; error?: string }>;
	listProjects(): Promise<IpcResult<{ projects: ProjectInfo[] }>>;
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
	getUserProfile(): Promise<
		IpcResult<{ profile: { userId: string; email: string; userName: string; avatar: string } | null }>
	>;
	updateUserProfile(patch: unknown): Promise<IpcResult>;
	resetUserProfile(): Promise<IpcResult>;
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
	testImConnection(appId: string): Promise<{ success: boolean; message: string }>;
	testImConnectionDirect(appId: string, appSecret: string): Promise<{ success: boolean; message: string }>;
	updateImChannel(appId: string, updates: { name?: string }): Promise<{ success: boolean; error?: string }>;
	// ---- MCP tools ----
	listAllMcpTools(): Promise<{
		success: boolean;
		tools?: Array<{ server: string; tool: { name: string; description?: string } }>;
		error?: string;
	}>;
	// ---- Usage & updates ----
	getUsage(): Promise<IpcResult<{ usage: unknown }>>;
	checkForUpdates(): Promise<IpcResult<{ updateAvailable: boolean; version?: string }>>;
	downloadUpdate(): Promise<IpcResult>;
	installUpdate(): Promise<IpcResult>;
	listPrompts(): Promise<IpcResult<{ prompts: unknown[] }>>;
	createPrompt(name: string, content: string): Promise<IpcResult>;
	updatePrompt(id: string, patch: unknown): Promise<IpcResult>;
	deletePrompt(id: string): Promise<IpcResult>;
	setActivePrompt(id: string): Promise<IpcResult>;
	listProjectPrompts(projectId: string): Promise<IpcResult<{ prompts: unknown[] }>>;
	createProjectPrompt(projectId: string, name: string, content: string): Promise<IpcResult>;
	updateProjectPrompt(projectId: string, id: string, patch: unknown): Promise<IpcResult>;
	deleteProjectPrompt(projectId: string, id: string): Promise<IpcResult>;
	setProjectActivePrompt(projectId: string, id: string): Promise<IpcResult>;
	listMcpServers(): Promise<IpcResult<{ servers: unknown[] }>>;
	listMcpTools(name: string): Promise<IpcResult<{ tools: unknown[] }>>;
	addMcpServer(config: unknown): Promise<IpcResult>;
	removeMcpServer(name: string): Promise<IpcResult>;
	testMcpServer(name: string): Promise<IpcResult<{ tools: unknown[]; error?: string }>>;
	toggleMcpServer(name: string, enabled: boolean): Promise<IpcResult>;
	updateMcpServer(name: string, config: unknown): Promise<IpcResult>;
	exportChat(agentId: string, format?: string): Promise<IpcResult<{ filePath?: string }>>;
}

interface SkillEntry {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	source: "user" | "project" | "path";
	disableModelInvocation: boolean;
}

interface SkillDiagnostic {
	type: "warning" | "collision";
	message: string;
	path?: string;
}

interface GeneralSettings {
	language: "en" | "zh" | "ja";
	autoCollapse: boolean;
	compactionEnabled: boolean;
	permissionMode: "always" | "ask" | "plan";
	/** Most recent model the user picked in the bottom-bar ModelSelector.
	 *  Used by quick-create to seed new chat agents with the user's
	 *  current pick. null = "no preference" (main picks first available). */
	preferredModel: string | null;
	lastActiveSessionId: string;
	lastActiveProjectId: string;
	openProjectIds: string[];
	openedSessionIds: string[];
	/** SubAgent 功能总开关。关闭后所有会话的 subagent 工具对 LLM 不可见。 */
	subagentEnabled: boolean;
	/** 已启用的 SubAgent 定义名称列表。null=全部启用（向后兼容） */
	enabledAgentDefinitions: string[] | null;
	/** 已启用的 Skill 名称列表。null=全部启用（向后兼容） */
	enabledSkills: string[] | null;
}

declare global {
	const __APP_VERSION__: string;

	interface Window {
		look: LookAPI;
	}
}
