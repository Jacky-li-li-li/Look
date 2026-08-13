import type { LookAPI } from "@look/shared/contracts/ipc" with { "resolution-mode": "import" };
import type { MainToRendererEvent, RendererToMainEvent } from "@look/shared/types" with { "resolution-mode": "import" };
import { contextBridge, ipcRenderer, webUtils } from "electron";

// ============================================================
// Preload Script — contextBridge API (CommonJS for Electron sandbox)
//
// Exposes the Look IPC surface as `window.look` (canonical).
// No legacy `window.harness` alias remains; all renderer code
// must consume the API through `window.look`.
// ============================================================

/**
 * 类型化 invoke：载荷按 RendererToMainEvent union 做编译期校验。
 * 方法体内拼错/漏传字段会在构建时报错，而不是运行期静默失败。
 * （`api: LookAPI` 只校验方法签名，校验不了方法体里的载荷。）
 */
const invoke = <T extends RendererToMainEvent["type"]>(payload: Extract<RendererToMainEvent, { type: T }>) =>
	ipcRenderer.invoke("look:invoke", payload);

const api: LookAPI = {
	// User home directory, exposed as a sync constant so the renderer can
	// shorten absolute paths to ~/… (matches pi sdk's path display). In a
	// sandboxed preload we can't require("os"), but process.env is available.
	homedir: process.env.HOME || process.env.USERPROFILE || "",

	// Host platform, exposed as a sync constant so the renderer can apply
	// macOS-only chrome adjustments (e.g. traffic-light clearance with
	// titleBarStyle: "hiddenInset").
	platform: process.platform,

	send: (event) => ipcRenderer.send("look:event", event),
	invoke: (event) => ipcRenderer.invoke("look:invoke", event),

	onEvent: (callback) => {
		const handler = (_event: Electron.IpcRendererEvent, data: MainToRendererEvent) => callback(data);
		ipcRenderer.on("look:event", handler);
		return () => {
			ipcRenderer.removeListener("look:event", handler);
		};
	},

	sendMessage: (agentId, message, images, sendMode) =>
		invoke({ type: "agent:send-message", agentId, message, images, sendMode }),

	removeQueuedMessage: (agentId, text) => invoke({ type: "agent:remove-queued-message", agentId, text }),

	insertQueuedMessage: (agentId, text) => invoke({ type: "agent:insert-queued-message", agentId, text }),

	activateSession: (sessionId, opts) =>
		invoke({
			type: "agent:activate",
			agentId: sessionId,
			skipSnapshot: opts?.skipSnapshot,
		}),

	createAgent: (input) =>
		invoke({
			type: "agent:create",
			name: typeof input === "string" ? input : input?.name,
			projectId: typeof input === "object" ? input?.projectId : undefined,
			imProvider: typeof input === "object" ? input?.imProvider : undefined,
		}),

	destroyAgent: (agentId) => invoke({ type: "agent:destroy", agentId }),

	abortAgent: (agentId) => invoke({ type: "agent:abort", agentId }),

	loadHistoryPage: (sessionId, beforeEntryId, revision, limit) =>
		invoke({ type: "session:history-page", sessionId, beforeEntryId, revision, limit }),

	getModels: () => invoke({ type: "model:list" }),

	getProviders: () => invoke({ type: "model:providers" }),

	getAgents: () => invoke({ type: "agents:list" }),

	// ---- Scheduled tasks ----
	listScheduledTasks: () => invoke({ type: "scheduled-task:list" }),
	createScheduledTask: (task) => invoke({ type: "scheduled-task:create", task }),
	updateScheduledTask: (taskId, patch) => invoke({ type: "scheduled-task:update", taskId, patch }),
	startScheduledTask: (taskId) => invoke({ type: "scheduled-task:start", taskId }),
	pauseScheduledTask: (taskId) => invoke({ type: "scheduled-task:pause", taskId }),
	resumeScheduledTask: (taskId) => invoke({ type: "scheduled-task:resume", taskId }),
	deleteScheduledTask: (taskId) => invoke({ type: "scheduled-task:delete", taskId }),
	runScheduledTaskNow: (taskId) => invoke({ type: "scheduled-task:run-now", taskId }),
	testScheduledTask: (task, taskId) => invoke({ type: "scheduled-task:test", task, taskId }),
	listScheduledTaskLogs: (taskId, limit) => invoke({ type: "scheduled-task:logs", taskId, limit }),
	validateCron: (cron, timezone) => invoke({ type: "scheduled-task:validate-cron", cron, timezone }),

	// ---- Drafts ----
	listDrafts: () => invoke({ type: "draft:list" }),
	createDraft: (text) => invoke({ type: "draft:create", text }),
	updateDraft: (draftId, patch) => invoke({ type: "draft:update", draftId, patch }),
	deleteDraft: (draftId) => invoke({ type: "draft:delete", draftId }),

	switchModel: (agentId, model) => invoke({ type: "agent:switch-model", agentId, model }),

	updateThinking: (agentId, level) => invoke({ type: "agent:update-thinking", agentId, level }),

	getSettings: () => invoke({ type: "settings:get" }),

	getApiKey: (provider, opts) => invoke({ type: "settings:get-api-key", provider, reveal: opts?.reveal }),

	testApiKey: (provider, key) => invoke({ type: "settings:test-api-key", provider, key }),

	// Test the env-var credential for a provider (no key arg — the
	// main process reads it from process.env itself, so the renderer
	// never has to know the variable name).
	testEnvKey: (provider) => invoke({ type: "settings:test-env-key", provider }),

	// ---- Provider OAuth login ----
	providerLogin: (provider) => invoke({ type: "settings:provider-login", provider }),

	providerLogout: (provider) => invoke({ type: "settings:provider-logout", provider }),

	respondLoginPrompt: (promptId, value) => invoke({ type: "login:prompt-respond", promptId, value }),

	cancelLoginPrompt: (promptId) => invoke({ type: "login:prompt-cancel", promptId }),

	// ---- Custom providers ----
	addCustomProvider: (input) => invoke({ type: "settings:add-custom-provider", payload: input }),
	updateCustomProvider: (name, patch) => invoke({ type: "settings:update-custom-provider", payload: { name, patch } }),
	removeCustomProvider: (name) => invoke({ type: "settings:remove-custom-provider", payload: { name } }),
	listCustomProviders: () => invoke({ type: "settings:list-custom-providers" }),
	testCustomProvider: (input) => invoke({ type: "settings:test-custom-provider", payload: input }),

	setApiKey: (provider, key) => invoke({ type: "settings:set-api-key", provider, key }),

	getGeneralSettings: () => invoke({ type: "settings:general:get" }),

	setGeneralSettings: (settings) => invoke({ type: "settings:general:set", settings }),

	resetGeneralSettings: () => invoke({ type: "settings:general:reset" }),

	compressSession: (agentId, customInstructions) => invoke({ type: "session:compress", agentId, customInstructions }),

	abortCompressSession: (agentId) => invoke({ type: "session:abort-compress", agentId }),

	renameAgent: (agentId, name) => invoke({ type: "agent:rename", agentId, name }),

	// ---- v0.3 skills ----
	listSkills: () => invoke({ type: "skills:list" }),

	importSkillPaths: (paths) => invoke({ type: "skills:import-paths", paths }),
	detectCommonSkillPaths: () => invoke({ type: "skills:detect-common" }),

	// ---- MCP tools ----
	listAllMcpTools: () => invoke({ type: "mcp:list-all-tools" }),

	// ---- OS native dialogs ----
	// Returns { success, path?, canceled?, error? }. The renderer
	// is sandboxed, so it can't call `dialog.showOpenDialog` itself.
	openDirectoryDialog: (title) => invoke({ type: "dialog:open-directory", title }),
	openFileDialog: (options) =>
		invoke({
			type: "dialog:open-files",
			title: options?.title,
			allowDirectories: options?.allowDirectories,
			allowMultiple: options?.allowMultiple,
		}),

	// ---- File paths from drag/drop ----
	// Electron's sandboxed renderer strips `file.path` from File objects.
	// Use webUtils.getPathForFile to recover the absolute path. Falls back
	// to null if webUtils is unavailable or the File object is invalid
	// (e.g. dragged directory — browsers don't expose directory paths).
	getPathForFile: (file) => {
		try {
			return webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]) || null;
		} catch {
			return null;
		}
	},

	// ---- OS shell ----
	// Reveal a file in the OS file manager (Finder / Explorer / etc).
	revealInFinder: (path) => invoke({ type: "shell:reveal-in-finder", path }),

	// Opens a project's canonical cwd in the OS file manager.
	openProjectFolder: (projectId) => invoke({ type: "shell:open-project-folder", projectId }),

	// ---- Project CRUD ----
	listProjects: () => invoke({ type: "project:list" }),
	createProject: (cwd, name) => invoke({ type: "project:create", cwd, name }),
	switchProject: (projectId) => invoke({ type: "project:switch", projectId }),
	renameProject: (projectId, name) => invoke({ type: "project:rename", projectId, name }),
	deleteProject: (projectId) => invoke({ type: "project:delete", projectId }),
	confirmDeleteProject: (projectId, confirmed) =>
		invoke({ type: "project:confirm-delete-response", projectId, confirmed }),
	getActiveProject: () => invoke({ type: "project:get-active" }),
	getProjectGitInfo: (projectId) => invoke({ type: "project:git-info", projectId }),
	getProjectGitDiff: (projectId) => invoke({ type: "project:git-diff", projectId }),
	getProjectGitFileHead: (projectId, absolutePath) =>
		invoke({ type: "project:git-file-head", projectId, absolutePath }),
	getGitFileHead: (absolutePath) => invoke({ type: "git:file-head", absolutePath }),

	// ---- v0.4 Session tree / branching ----
	// `window.look.*` API surface for the tree-view UI and the
	// hover-action buttons in MessageBubble. The renderer never
	// touches pi's SessionManager directly — all reads/writes go
	// through the main process and the active AgentSessionRuntime.
	// opts: { summarize?, customInstructions?, label? }
	// returns: { editorText?, cancelled: boolean, aborted?: boolean }
	navigateTree: (agentId, entryId, opts) =>
		invoke({
			type: "agent:navigate-tree",
			agentId,
			entryId,
			summarize: opts?.summarize,
			customInstructions: opts?.customInstructions,
			label: opts?.label,
		}),
	// opts: { name? } — defaults to `${parentName} · fork`
	// returns: { agentId, sessionFilePath }
	createFork: (agentId, entryId, opts) =>
		invoke({
			type: "agent:create-fork",
			agentId,
			entryId,
			name: opts?.name,
		}),
	// label: string | null — null/empty clears
	setEntryLabel: (agentId, entryId, label) =>
		invoke({
			type: "agent:set-entry-label",
			agentId,
			entryId,
			label,
		}),

	// ---- Shared area ----
	listSharedFiles: (projectId) => invoke({ type: "shared:list", projectId }),
	listSharedChildren: (projectId, relativePath) => invoke({ type: "shared:list-children", projectId, relativePath }),
	startSharedWatch: (projectId) => invoke({ type: "shared:watch", projectId }),
	stopSharedWatch: (projectId) => invoke({ type: "shared:unwatch", projectId }),
	writeSharedFile: (projectId, path, content) => invoke({ type: "shared:write", projectId, path, content }),
	createSharedDir: (projectId, path) => invoke({ type: "shared:mkdir", projectId, path }),
	deleteSharedItem: (projectId, path) => invoke({ type: "shared:delete", projectId, path }),
	importToShared: (projectId, sources, targetDir) => invoke({ type: "shared:import", projectId, sources, targetDir }),
	exportFromShared: (projectId, paths, destDir) => invoke({ type: "shared:export", projectId, paths, destDir }),
	// Drag-drop fallback: write base64/utf8 content when no absolute path
	// is available (e.g. dropped into a sandboxed renderer).
	writeSharedContent: (projectId, path, content, encoding = "utf8") =>
		invoke({ type: "shared:write-content", projectId, path, content, encoding }),

	// ---- Workspace tree (v0.6) ----
	listWorkspaceChildren: (projectId, relativePath, showHiddenFiles = true) =>
		invoke({ type: "workspace:list-children", projectId, relativePath, showHiddenFiles }),
	statWorkspaceNode: (projectId, relativePath) => invoke({ type: "workspace:stat", projectId, relativePath }),
	startWorkspaceWatch: (projectId, relativePath) => invoke({ type: "workspace:watch", projectId, relativePath }),
	stopWorkspaceWatch: (projectId, relativePath) => invoke({ type: "workspace:unwatch", projectId, relativePath }),

	// ---- File read/write ----
	readFileContent: (path) => invoke({ type: "file:read", path }),
	writeFileContent: (path, content) => invoke({ type: "file:write", path, content }),
	statFilePath: (path) => invoke({ type: "file:stat", path }),

	// ---- File viewer window ----
	openFileViewer: (path, fadeIn, diffPatch) =>
		invoke({
			type: "fileViewer:open",
			path,
			fadeIn,
			...(diffPatch !== undefined ? { diffPatch } : {}),
		}),
	dockFileViewer: (path, diffPatch) =>
		invoke({ type: "fileViewer:dock", path, ...(diffPatch !== undefined ? { diffPatch } : {}) }),
	resolveFileViewerDock: (confirmed) => invoke({ type: "fileViewer:dock-result", confirmed }),
	fileViewerReady: () => invoke({ type: "fileViewer:ready" }),

	// ---- Auto Updater ----
	checkForUpdates: () => invoke({ type: "update:check" }),
	downloadUpdate: () => invoke({ type: "update:download" }),
	installUpdate: () => invoke({ type: "update:install" }),

	// ---- Permission management ----
	setPermissionMode: (agentId, mode, updateDefault) =>
		invoke({ type: "permission:set-mode", agentId, mode, updateDefault }),
	getPermissionMode: (agentId) => invoke({ type: "permission:get-mode", agentId }),
	respondPermission: (payload) => invoke({ type: "permission:respond", payload }),
	respondPlanQuestion: (payload) => invoke({ type: "plan:question-respond", payload }),
	respondPlanApproval: (payload) => invoke({ type: "plan:approval-respond", payload }),

	// ---- SubAgent：子会话关系查询（Stage 4 嵌套） ----
	listSubSessions: (parentSessionId) => invoke({ type: "agent:list-subagents", parentSessionId }),
	getParentSession: (childSessionId) => invoke({ type: "agent:get-parent-session", childSessionId }),

	reviewChanges: (payload) =>
		invoke({
			type: "agent:review-changes",
			parentSessionId: payload.parentSessionId,
			title: payload.title,
			turnKey: payload.turnKey,
		}),

	// ---- SubAgent：Agent 定义 CRUD（Stage 3 广场） ----
	listAgentDefinitions: () => invoke({ type: "agent-definitions:list" }),
	createAgentDefinition: (input) => invoke({ type: "agent-definitions:create", input }),
	updateAgentDefinition: (name, input) => invoke({ type: "agent-definitions:update", name, input }),
	deleteAgentDefinition: (name) => invoke({ type: "agent-definitions:delete", name }),
	installAgentDefinition: (name) => invoke({ type: "agent-definitions:install", name, source: "builtin" }),

	// ---- SubAgent：Agent 开关（Stage 2，应用到所有活动会话 + 持久化为默认） ----
	setSubagentEnabled: (enabled) => invoke({ type: "agent:set-subagent-enabled", enabled }),

	// ---- SubAgent：单个 Agent 定义 / Skill 的启用开关（Agent 广场） ----
	setAgentDefinitionEnabled: (name, enabled) =>
		invoke({
			type: "agent-definitions:set-enabled",
			name,
			enabled,
		}),
	setSkillEnabled: (name, enabled) =>
		invoke({
			type: "skills:set-enabled",
			name,
			enabled,
		}),

	// ---- User Profile ----
	openOAuthUrl: (url, redirectTo) => invoke({ type: "auth:open-oauth-url", url, redirectTo }),

	getUserProfile: () => invoke({ type: "user-profile:get" }),
	updateUserProfile: (patch) => invoke({ type: "user-profile:update", patch }),
	resetUserProfile: () => invoke({ type: "user-profile:reset" }),
	logout: () => invoke({ type: "user-profile:logout" }),

	// ---- Usage heatmap ----
	getUsage: () => invoke({ type: "usage:get" }),

	// ---- IM Channels ----
	getImChannels: () => invoke({ type: "im:get-channels" }),
	getImBindings: () => invoke({ type: "im:get-bindings" }),
	connectFeishuChannel: (options) =>
		invoke({
			type: "im:connect-feishu",
			appName: options?.appName,
			description: options?.description,
		}),
	connectFeishuManualChannel: (input) =>
		invoke({
			type: "im:connect-feishu-manual",
			appId: input.appId,
			appSecret: input.appSecret,
			name: input.name,
		}),
	cancelFeishuRegistration: (registrationId) =>
		invoke({
			type: "im:cancel-registration",
			registrationId,
		}),
	disconnectImChannel: (provider, appId) => invoke({ type: "im:disconnect-channel", provider, appId }),
	removeImChannel: (provider, appId) => invoke({ type: "im:remove-channel", provider, appId }),
	reconnectImChannel: (provider, appId) => invoke({ type: "im:reconnect-channel", provider, appId }),
	sendImTestMessage: (input) =>
		invoke({
			type: "im:send-test-message",
			receiveIdType: input.receiveIdType,
			receiveId: input.receiveId,
			text: input.text,
		}),
	testImConnection: (appId) =>
		invoke({
			type: "im:test-connection",
			appId,
		}),
	testImConnectionDirect: (appId, appSecret) =>
		invoke({
			type: "im:test-connection-direct",
			appId,
			appSecret,
		}),
	updateImChannel: (appId, updates) =>
		invoke({
			type: "im:update-channel",
			appId,
			name: updates.name,
		}),

	// ---- Custom System Prompts ----
	listPrompts: () => invoke({ type: "settings:prompts:list" }),
	createPrompt: (name, content) => invoke({ type: "settings:prompts:create", name, content }),
	updatePrompt: (id, patch) => {
		// 显式提取 patch 字段，禁止 patch 展开覆盖信封字段（type/id）：
		// 恶意/错误 patch 不能把更新静默变成删除或改到其他 prompt。
		const p = patch as Record<string, unknown>;
		return invoke({
			type: "settings:prompts:update",
			id,
			name: "name" in p && p.name !== undefined ? (p.name as string) : undefined,
			content: "content" in p && p.content !== undefined ? (p.content as string) : undefined,
		});
	},
	deletePrompt: (id) => invoke({ type: "settings:prompts:delete", id }),
	setActivePrompt: (id) => invoke({ type: "settings:prompts:set-active", id }),

	// ---- Project-level Prompts ----
	listProjectPrompts: (projectId) => invoke({ type: "settings:project-prompts:list", projectId }),
	createProjectPrompt: (projectId, name, content) =>
		invoke({ type: "settings:project-prompts:create", projectId, name, content }),
	updateProjectPrompt: (projectId, id, patch) =>
		invoke({
			type: "settings:project-prompts:update",
			projectId,
			id,
			name: "name" in patch ? ((patch as Record<string, unknown>).name as string | undefined) : undefined,
			content: "content" in patch ? ((patch as Record<string, unknown>).content as string | undefined) : undefined,
		}),
	deleteProjectPrompt: (projectId, id) => invoke({ type: "settings:project-prompts:delete", projectId, id }),
	setProjectActivePrompt: (projectId, id) => invoke({ type: "settings:project-prompts:set-active", projectId, id }),

	// MCP server management
	listMcpServers: () => invoke({ type: "mcp:list-servers" }),
	listMcpTools: (name) => invoke({ type: "mcp:list-tools", name }),
	addMcpServer: (config) => invoke({ type: "mcp:add-server", config }),
	removeMcpServer: (name) => invoke({ type: "mcp:remove-server", name }),
	testMcpServer: (name) => invoke({ type: "mcp:test-server", name }),
	toggleMcpServer: (name, enabled) => invoke({ type: "mcp:toggle-server", name, enabled }),
	updateMcpServer: (name, config) => invoke({ type: "mcp:update-server", name, config }),
};

contextBridge.exposeInMainWorld("look", api);
