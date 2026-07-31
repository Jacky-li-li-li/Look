import type { LookAPI } from "@look/shared/contracts/ipc" with { "resolution-mode": "import" };
import type { MainToRendererEvent } from "@look/shared/types" with { "resolution-mode": "import" };
import { contextBridge, ipcRenderer, webUtils } from "electron";

// ============================================================
// Preload Script — contextBridge API (CommonJS for Electron sandbox)
//
// Exposes the Look IPC surface as `window.look` (canonical).
// No legacy `window.harness` alias remains; all renderer code
// must consume the API through `window.look`.
// ============================================================

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
		ipcRenderer.invoke("look:invoke", { type: "agent:send-message", agentId, message, images, sendMode }),

	removeQueuedMessage: (agentId, text) =>
		ipcRenderer.invoke("look:invoke", { type: "agent:remove-queued-message", agentId, text }),

	insertQueuedMessage: (agentId, text) =>
		ipcRenderer.invoke("look:invoke", { type: "agent:insert-queued-message", agentId, text }),

	activateSession: (sessionId) => ipcRenderer.invoke("look:invoke", { type: "agent:activate", agentId: sessionId }),

	createAgent: (input) =>
		ipcRenderer.invoke("look:invoke", {
			type: "agent:create",
			name: typeof input === "string" ? input : input?.name,
			projectId: typeof input === "object" ? input?.projectId : undefined,
			imProvider: typeof input === "object" ? input?.imProvider : undefined,
		}),

	destroyAgent: (agentId) => ipcRenderer.invoke("look:invoke", { type: "agent:destroy", agentId }),

	abortAgent: (agentId) => ipcRenderer.invoke("look:invoke", { type: "agent:abort", agentId }),

	getModels: () => ipcRenderer.invoke("look:invoke", { type: "model:list" }),

	getProviders: () => ipcRenderer.invoke("look:invoke", { type: "model:providers" }),

	getAgents: () => ipcRenderer.invoke("look:invoke", { type: "agents:list" }),

	// ---- Scheduled tasks ----
	listScheduledTasks: () => ipcRenderer.invoke("look:invoke", { type: "scheduled-task:list" }),
	createScheduledTask: (task) => ipcRenderer.invoke("look:invoke", { type: "scheduled-task:create", task }),
	updateScheduledTask: (taskId, patch) =>
		ipcRenderer.invoke("look:invoke", { type: "scheduled-task:update", taskId, patch }),
	startScheduledTask: (taskId) => ipcRenderer.invoke("look:invoke", { type: "scheduled-task:start", taskId }),
	pauseScheduledTask: (taskId) => ipcRenderer.invoke("look:invoke", { type: "scheduled-task:pause", taskId }),
	resumeScheduledTask: (taskId) => ipcRenderer.invoke("look:invoke", { type: "scheduled-task:resume", taskId }),
	deleteScheduledTask: (taskId) => ipcRenderer.invoke("look:invoke", { type: "scheduled-task:delete", taskId }),
	runScheduledTaskNow: (taskId) => ipcRenderer.invoke("look:invoke", { type: "scheduled-task:run-now", taskId }),
	testScheduledTask: (task, taskId) =>
		ipcRenderer.invoke("look:invoke", { type: "scheduled-task:test", task, taskId }),
	listScheduledTaskLogs: (taskId, limit) =>
		ipcRenderer.invoke("look:invoke", { type: "scheduled-task:logs", taskId, limit }),
	validateCron: (cron, timezone) =>
		ipcRenderer.invoke("look:invoke", { type: "scheduled-task:validate-cron", cron, timezone }),

	switchModel: (agentId, model) => ipcRenderer.invoke("look:invoke", { type: "agent:switch-model", agentId, model }),

	updateThinking: (agentId, level) =>
		ipcRenderer.invoke("look:invoke", { type: "agent:update-thinking", agentId, level }),

	getSettings: () => ipcRenderer.invoke("look:invoke", { type: "settings:get" }),

	getApiKey: (provider, opts) =>
		ipcRenderer.invoke("look:invoke", { type: "settings:get-api-key", provider, reveal: opts?.reveal }),

	testApiKey: (provider, key) => ipcRenderer.invoke("look:invoke", { type: "settings:test-api-key", provider, key }),

	// Test the env-var credential for a provider (no key arg — the
	// main process reads it from process.env itself, so the renderer
	// never has to know the variable name).
	testEnvKey: (provider) => ipcRenderer.invoke("look:invoke", { type: "settings:test-env-key", provider }),

	// ---- Provider OAuth login ----
	providerLogin: (provider) => ipcRenderer.invoke("look:invoke", { type: "settings:provider-login", provider }),

	providerLogout: (provider) => ipcRenderer.invoke("look:invoke", { type: "settings:provider-logout", provider }),

	respondLoginPrompt: (promptId, value) =>
		ipcRenderer.invoke("look:invoke", { type: "login:prompt-respond", promptId, value }),

	cancelLoginPrompt: (promptId) => ipcRenderer.invoke("look:invoke", { type: "login:prompt-cancel", promptId }),

	// ---- Custom providers ----
	addCustomProvider: (input) =>
		ipcRenderer.invoke("look:invoke", { type: "settings:add-custom-provider", payload: input }),
	updateCustomProvider: (name, patch) =>
		ipcRenderer.invoke("look:invoke", { type: "settings:update-custom-provider", payload: { name, patch } }),
	removeCustomProvider: (name) =>
		ipcRenderer.invoke("look:invoke", { type: "settings:remove-custom-provider", payload: { name } }),
	listCustomProviders: () => ipcRenderer.invoke("look:invoke", { type: "settings:list-custom-providers" }),
	testCustomProvider: (input) =>
		ipcRenderer.invoke("look:invoke", { type: "settings:test-custom-provider", payload: input }),

	setApiKey: (provider, key) => ipcRenderer.invoke("look:invoke", { type: "settings:set-api-key", provider, key }),

	getGeneralSettings: () => ipcRenderer.invoke("look:invoke", { type: "settings:general:get" }),

	setGeneralSettings: (settings) => ipcRenderer.invoke("look:invoke", { type: "settings:general:set", settings }),

	resetGeneralSettings: () => ipcRenderer.invoke("look:invoke", { type: "settings:general:reset" }),

	compressSession: (agentId, customInstructions) =>
		ipcRenderer.invoke("look:invoke", { type: "session:compress", agentId, customInstructions }),

	abortCompressSession: (agentId) => ipcRenderer.invoke("look:invoke", { type: "session:abort-compress", agentId }),

	renameAgent: (agentId, name) => ipcRenderer.invoke("look:invoke", { type: "agent:rename", agentId, name }),

	// ---- v0.3 skills ----
	listSkills: () => ipcRenderer.invoke("look:invoke", { type: "skills:list" }),

	importSkillPaths: (paths) => ipcRenderer.invoke("look:invoke", { type: "skills:import-paths", paths }),
	detectCommonSkillPaths: () => ipcRenderer.invoke("look:invoke", { type: "skills:detect-common" }),

	// ---- MCP tools ----
	listAllMcpTools: () => ipcRenderer.invoke("look:invoke", { type: "mcp:list-all-tools" }),

	// ---- OS native dialogs ----
	// Returns { success, path?, canceled?, error? }. The renderer
	// is sandboxed, so it can't call `dialog.showOpenDialog` itself.
	openDirectoryDialog: (title) => ipcRenderer.invoke("look:invoke", { type: "dialog:open-directory", title }),
	openFileDialog: (options) =>
		ipcRenderer.invoke("look:invoke", {
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
	revealInFinder: (path) => ipcRenderer.invoke("look:invoke", { type: "shell:reveal-in-finder", path }),

	// Opens a project's canonical cwd in the OS file manager.
	openProjectFolder: (projectId) =>
		ipcRenderer.invoke("look:invoke", { type: "shell:open-project-folder", projectId }),

	// ---- Project CRUD ----
	listProjects: () => ipcRenderer.invoke("look:invoke", { type: "project:list" }),
	createProject: (cwd, name) => ipcRenderer.invoke("look:invoke", { type: "project:create", cwd, name }),
	switchProject: (projectId) => ipcRenderer.invoke("look:invoke", { type: "project:switch", projectId }),
	renameProject: (projectId, name) => ipcRenderer.invoke("look:invoke", { type: "project:rename", projectId, name }),
	deleteProject: (projectId) => ipcRenderer.invoke("look:invoke", { type: "project:delete", projectId }),
	confirmDeleteProject: (projectId, confirmed) =>
		ipcRenderer.invoke("look:invoke", { type: "project:confirm-delete-response", projectId, confirmed }),
	getActiveProject: () => ipcRenderer.invoke("look:invoke", { type: "project:get-active" }),

	// ---- v0.4 Session tree / branching ----
	// `window.look.*` API surface for the tree-view UI and the
	// hover-action buttons in MessageBubble. The renderer never
	// touches pi's SessionManager directly — all reads/writes go
	// through the main process and the active AgentSessionRuntime.
	// opts: { summarize?, customInstructions?, label? }
	// returns: { editorText?, cancelled: boolean, aborted?: boolean }
	navigateTree: (agentId, entryId, opts) =>
		ipcRenderer.invoke("look:invoke", {
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
		ipcRenderer.invoke("look:invoke", {
			type: "agent:create-fork",
			agentId,
			entryId,
			name: opts?.name,
		}),
	// label: string | null — null/empty clears
	setEntryLabel: (agentId, entryId, label) =>
		ipcRenderer.invoke("look:invoke", {
			type: "agent:set-entry-label",
			agentId,
			entryId,
			label,
		}),

	// ---- Shared area ----
	listSharedFiles: (projectId) => ipcRenderer.invoke("look:invoke", { type: "shared:list", projectId }),
	startSharedWatch: (projectId) => ipcRenderer.invoke("look:invoke", { type: "shared:watch", projectId }),
	stopSharedWatch: (projectId) => ipcRenderer.invoke("look:invoke", { type: "shared:unwatch", projectId }),
	writeSharedFile: (projectId, path, content) =>
		ipcRenderer.invoke("look:invoke", { type: "shared:write", projectId, path, content }),
	createSharedDir: (projectId, path) => ipcRenderer.invoke("look:invoke", { type: "shared:mkdir", projectId, path }),
	deleteSharedItem: (projectId, path) => ipcRenderer.invoke("look:invoke", { type: "shared:delete", projectId, path }),
	importToShared: (projectId, sources, targetDir) =>
		ipcRenderer.invoke("look:invoke", { type: "shared:import", projectId, sources, targetDir }),
	exportFromShared: (projectId, paths, destDir) =>
		ipcRenderer.invoke("look:invoke", { type: "shared:export", projectId, paths, destDir }),
	// Drag-drop fallback: write base64/utf8 content when no absolute path
	// is available (e.g. dropped into a sandboxed renderer).
	writeSharedContent: (projectId, path, content, encoding = "utf8") =>
		ipcRenderer.invoke("look:invoke", { type: "shared:write-content", projectId, path, content, encoding }),

	// ---- Workspace tree (v0.6) ----
	listWorkspaceChildren: (projectId, relativePath, showHiddenFiles = false) =>
		ipcRenderer.invoke("look:invoke", { type: "workspace:list-children", projectId, relativePath, showHiddenFiles }),
	statWorkspaceNode: (projectId, relativePath) =>
		ipcRenderer.invoke("look:invoke", { type: "workspace:stat", projectId, relativePath }),
	startWorkspaceWatch: (projectId, relativePath) =>
		ipcRenderer.invoke("look:invoke", { type: "workspace:watch", projectId, relativePath }),
	stopWorkspaceWatch: (projectId, relativePath) =>
		ipcRenderer.invoke("look:invoke", { type: "workspace:unwatch", projectId, relativePath }),

	// ---- File read/write ----
	readFileContent: (path) => ipcRenderer.invoke("look:invoke", { type: "file:read", path }),
	writeFileContent: (path, content) => ipcRenderer.invoke("look:invoke", { type: "file:write", path, content }),
	statFilePath: (path) => ipcRenderer.invoke("look:invoke", { type: "file:stat", path }),

	// ---- File viewer window ----
	openFileViewer: (path) => ipcRenderer.invoke("look:invoke", { type: "fileViewer:open", path }),
	fileViewerReady: () => ipcRenderer.invoke("look:invoke", { type: "fileViewer:ready" }),

	// ---- Auto Updater ----
	checkForUpdates: () => ipcRenderer.invoke("look:invoke", { type: "update:check" }),
	downloadUpdate: () => ipcRenderer.invoke("look:invoke", { type: "update:download" }),
	installUpdate: () => ipcRenderer.invoke("look:invoke", { type: "update:install" }),

	// ---- Permission management ----
	setPermissionMode: (agentId, mode, updateDefault) =>
		ipcRenderer.invoke("look:invoke", { type: "permission:set-mode", agentId, mode, updateDefault }),
	getPermissionMode: (agentId) => ipcRenderer.invoke("look:invoke", { type: "permission:get-mode", agentId }),
	respondPermission: (payload) => ipcRenderer.invoke("look:invoke", { type: "permission:respond", payload }),
	respondPlanQuestion: (payload) => ipcRenderer.invoke("look:invoke", { type: "plan:question-respond", payload }),
	respondPlanApproval: (payload) => ipcRenderer.invoke("look:invoke", { type: "plan:approval-respond", payload }),

	// ---- SubAgent：子会话关系查询（Stage 4 嵌套） ----
	listSubSessions: (parentSessionId) =>
		ipcRenderer.invoke("look:invoke", { type: "agent:list-subagents", parentSessionId }),
	getParentSession: (childSessionId) =>
		ipcRenderer.invoke("look:invoke", { type: "agent:get-parent-session", childSessionId }),

	// ---- SubAgent：Agent 定义 CRUD（Stage 3 广场） ----
	listAgentDefinitions: () => ipcRenderer.invoke("look:invoke", { type: "agent-definitions:list" }),
	createAgentDefinition: (input) => ipcRenderer.invoke("look:invoke", { type: "agent-definitions:create", input }),
	updateAgentDefinition: (name, input) =>
		ipcRenderer.invoke("look:invoke", { type: "agent-definitions:update", name, input }),
	deleteAgentDefinition: (name) => ipcRenderer.invoke("look:invoke", { type: "agent-definitions:delete", name }),
	installAgentDefinition: (name) => ipcRenderer.invoke("look:invoke", { type: "agent-definitions:install", name }),

	// ---- SubAgent：Agent 开关（Stage 2，应用到所有活动会话 + 持久化为默认） ----
	setSubagentEnabled: (enabled) => ipcRenderer.invoke("look:invoke", { type: "agent:set-subagent-enabled", enabled }),

	// ---- SubAgent：单个 Agent 定义 / Skill 的启用开关（Agent 广场） ----
	setAgentDefinitionEnabled: (name, enabled) =>
		ipcRenderer.invoke("look:invoke", {
			type: "agent-definitions:set-enabled",
			name,
			enabled,
		}),
	setSkillEnabled: (name, enabled) =>
		ipcRenderer.invoke("look:invoke", {
			type: "skills:set-enabled",
			name,
			enabled,
		}),

	// ---- User Profile ----
	openOAuthUrl: (url, redirectTo) =>
		ipcRenderer.invoke("look:invoke", { type: "auth:open-oauth-url", url, redirectTo }),

	getUserProfile: () => ipcRenderer.invoke("look:invoke", { type: "user-profile:get" }),
	updateUserProfile: (patch) => ipcRenderer.invoke("look:invoke", { type: "user-profile:update", patch }),
	resetUserProfile: () => ipcRenderer.invoke("look:invoke", { type: "user-profile:reset" }),
	logout: () => ipcRenderer.invoke("look:invoke", { type: "user-profile:logout" }),

	// ---- Usage heatmap ----
	getUsage: () => ipcRenderer.invoke("look:invoke", { type: "usage:get" }),

	// ---- IM Channels ----
	getImChannels: () => ipcRenderer.invoke("look:invoke", { type: "im:get-channels" }),
	getImBindings: () => ipcRenderer.invoke("look:invoke", { type: "im:get-bindings" }),
	connectFeishuChannel: (options) =>
		ipcRenderer.invoke("look:invoke", {
			type: "im:connect-feishu",
			appName: options?.appName,
			description: options?.description,
		}),
	connectFeishuManualChannel: (input) =>
		ipcRenderer.invoke("look:invoke", {
			type: "im:connect-feishu-manual",
			appId: input.appId,
			appSecret: input.appSecret,
			name: input.name,
		}),
	cancelFeishuRegistration: (registrationId) =>
		ipcRenderer.invoke("look:invoke", {
			type: "im:cancel-registration",
			registrationId,
		}),
	disconnectImChannel: (provider, appId) =>
		ipcRenderer.invoke("look:invoke", { type: "im:disconnect-channel", provider, appId }),
	removeImChannel: (provider, appId) =>
		ipcRenderer.invoke("look:invoke", { type: "im:remove-channel", provider, appId }),
	reconnectImChannel: (provider, appId) =>
		ipcRenderer.invoke("look:invoke", { type: "im:reconnect-channel", provider, appId }),
	sendImTestMessage: (input) =>
		ipcRenderer.invoke("look:invoke", {
			type: "im:send-test-message",
			receiveIdType: input.receiveIdType,
			receiveId: input.receiveId,
			text: input.text,
		}),
	testImConnection: (appId) =>
		ipcRenderer.invoke("look:invoke", {
			type: "im:test-connection",
			appId,
		}),
	testImConnectionDirect: (appId, appSecret) =>
		ipcRenderer.invoke("look:invoke", {
			type: "im:test-connection-direct",
			appId,
			appSecret,
		}),
	updateImChannel: (appId, updates) =>
		ipcRenderer.invoke("look:invoke", {
			type: "im:update-channel",
			appId,
			name: updates.name,
		}),

	// ---- Custom System Prompts ----
	listPrompts: () => ipcRenderer.invoke("look:invoke", { type: "settings:prompts:list" }),
	createPrompt: (name, content) =>
		ipcRenderer.invoke("look:invoke", { type: "settings:prompts:create", name, content }),
	updatePrompt: (id, patch) => ipcRenderer.invoke("look:invoke", { type: "settings:prompts:update", id, ...patch }),
	deletePrompt: (id) => ipcRenderer.invoke("look:invoke", { type: "settings:prompts:delete", id }),
	setActivePrompt: (id) => ipcRenderer.invoke("look:invoke", { type: "settings:prompts:set-active", id }),

	// ---- Project-level Prompts ----
	listProjectPrompts: (projectId) =>
		ipcRenderer.invoke("look:invoke", { type: "settings:project-prompts:list", projectId }),
	createProjectPrompt: (projectId, name, content) =>
		ipcRenderer.invoke("look:invoke", { type: "settings:project-prompts:create", projectId, name, content }),
	updateProjectPrompt: (projectId, id, patch) =>
		ipcRenderer.invoke("look:invoke", {
			type: "settings:project-prompts:update",
			projectId,
			id,
			name: "name" in patch ? (patch as Record<string, unknown>).name : undefined,
			content: "content" in patch ? (patch as Record<string, unknown>).content : undefined,
		}),
	deleteProjectPrompt: (projectId, id) =>
		ipcRenderer.invoke("look:invoke", { type: "settings:project-prompts:delete", projectId, id }),
	setProjectActivePrompt: (projectId, id) =>
		ipcRenderer.invoke("look:invoke", { type: "settings:project-prompts:set-active", projectId, id }),

	// MCP server management
	listMcpServers: () => ipcRenderer.invoke("look:invoke", { type: "mcp:list-servers" }),
	listMcpTools: (name) => ipcRenderer.invoke("look:invoke", { type: "mcp:list-tools", name }),
	addMcpServer: (config) => ipcRenderer.invoke("look:invoke", { type: "mcp:add-server", config }),
	removeMcpServer: (name) => ipcRenderer.invoke("look:invoke", { type: "mcp:remove-server", name }),
	testMcpServer: (name) => ipcRenderer.invoke("look:invoke", { type: "mcp:test-server", name }),
	toggleMcpServer: (name, enabled) => ipcRenderer.invoke("look:invoke", { type: "mcp:toggle-server", name, enabled }),
	updateMcpServer: (name, config) => ipcRenderer.invoke("look:invoke", { type: "mcp:update-server", name, config }),
};

contextBridge.exposeInMainWorld("look", api);
