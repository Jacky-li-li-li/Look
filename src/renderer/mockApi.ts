// ============================================================
// mockApi — 浏览器开发模式下的 window.look mock
//
// 当在浏览器中（非 Electron 环境）访问 Vite 开发服务器时，
// window.look 不存在。此 mock 提供最小化的 API 实现，
// 让渲染层能独立运行以便前端开发调试。
// ============================================================

const noop = () => {};

/** 泛型成功响应 */
function success<T>(data: T) {
	return Promise.resolve({ success: true, ...data });
}

/** 空成功响应 */
const ok = Promise.resolve({ success: true });

/** IPC 事件监听器 */
const listeners = new Set<(event: unknown) => void>();

const mockApi = {
	homedir: "/Users/jacky",

	send: noop,

	invoke: () => Promise.resolve({ success: true }),

	onEvent: (callback: (event: unknown) => void) => {
		listeners.add(callback);
		return () => {
			listeners.delete(callback);
		};
	},

	// ---- Agent ----
	sendMessage: () => ok,
	activateSession: () => ok,
	createAgent: () => ok,
	destroyAgent: () => ok,
	abortAgent: () => ok,
	switchModel: () => ok,
	updateThinking: () => ok,
	renameAgent: () => ok,
	compressSession: () => ok,

	// ---- Model ----
	getModels: () => success({ models: [] }),
	getProviders: () => success({ providers: [] }),

	// ---- Agents ----
	getAgents: () => success({ agents: [] }),

	// ---- Settings ----
	getSettings: () =>
		success({
			providers: [],
			customStats: { configured: 0, totalModels: 0 },
		}),
	getApiKey: () => Promise.resolve({ success: true, key: "" }),
	testApiKey: () => Promise.resolve({ success: true, valid: false }),
	testEnvKey: () => Promise.resolve({ success: true, valid: false }),
	setApiKey: () => ok,
	getGeneralSettings: () => success({ settings: {} }),
	setGeneralSettings: () => ok,
	resetGeneralSettings: () => ok,

	// ---- Custom providers ----
	addCustomProvider: () => ok,
	updateCustomProvider: () => ok,
	removeCustomProvider: () => ok,
	listCustomProviders: () => success({ providers: [] }),
	testCustomProvider: () => ok,

	// ---- Skills ----
	listSkills: () => success({ skills: [] }),
	importSkillPaths: () => ok,
	detectCommonSkillPaths: () => success({ paths: [] }),

	// ---- MCP ----
	listAllMcpTools: () => success({ tools: [] }),
	listMcpServers: () => success({ servers: [] }),
	listMcpTools: () => success({ tools: [] }),
	addMcpServer: () => ok,
	removeMcpServer: () => ok,
	testMcpServer: () => ok,
	toggleMcpServer: () => ok,
	updateMcpServer: () => ok,

	// ---- Dialog ----
	openDirectoryDialog: () => Promise.resolve({ success: true, canceled: true }),
	openFileDialog: () => Promise.resolve({ success: true, canceled: true }),

	// ---- File ----
	getPathForFile: () => null,

	// ---- Shell ----
	revealInFinder: () => ok,
	openProjectFolder: () => ok,

	// ---- Project CRUD ----
	listProjects: () =>
		success({
			projects: [
				{
					id: "dev-browser",
					name: "pi (浏览器预览)",
					cwd: "/Users/jacky/Desktop/pi",
					createdAt: Date.now(),
					valid: true,
				},
			],
			activeProjectId: "dev-browser",
		}),
	createProject: () => ok,
	switchProject: () => ok,
	renameProject: () => ok,
	deleteProject: () => ok,
	confirmDeleteProject: () => ok,
	getActiveProject: () => success({ projectId: "dev-browser" }),

	// ---- Session tree ----
	navigateTree: () => ok,
	createFork: () => ok,
	setEntryLabel: () => ok,

	// ---- Shared area ----
	listSharedFiles: () => success({ files: [] }),
	startSharedWatch: () => ok,
	stopSharedWatch: () => ok,
	writeSharedFile: () => ok,
	createSharedDir: () => ok,
	deleteSharedItem: () => ok,
	importToShared: () => ok,
	exportFromShared: () => ok,
	writeSharedContent: () => ok,

	// ---- Workspace tree ----
	listWorkspaceChildren: () => success({ children: [] }),
	statWorkspaceNode: () => success({ node: null }),
	startWorkspaceWatch: () => ok,
	stopWorkspaceWatch: () => ok,

	// ---- Auto Updater ----
	checkForUpdates: () => ok,
	downloadUpdate: () => ok,
	installUpdate: () => ok,

	// ---- Permission ----
	setPermissionMode: () => ok,
	getPermissionMode: () => success({ mode: "always" }),
	respondPermission: () => ok,
	respondPlanQuestion: () => ok,
	respondPlanApproval: () => ok,

	// ---- SubAgent ----
	listSubSessions: () => success({ sessions: [] }),
	getParentSession: () => Promise.resolve({ success: true, parentSessionId: null }),

	// ---- Agent Definitions ----
	listAgentDefinitions: () => success({ agents: [] }),
	createAgentDefinition: () => ok,
	updateAgentDefinition: () => ok,
	deleteAgentDefinition: () => ok,
	installAgentDefinition: () => ok,
	setSubagentEnabled: () => ok,
	setAgentDefinitionEnabled: () => ok,
	setSkillEnabled: () => ok,

	// ---- User Profile ----
	getUserProfile: () => Promise.resolve({ success: true, profile: null }),
	updateUserProfile: () => ok,
	resetUserProfile: () => ok,

	// ---- Usage ----
	getUsage: () => success({ usage: {}, modelCost: {}, years: [] }),

	// ---- IM Channels ----
	getImChannels: () => success({ channels: [] }),
	connectFeishuChannel: () => ok,
	connectFeishuManualChannel: () => ok,
	cancelFeishuRegistration: () => ok,
	disconnectImChannel: () => ok,
	removeImChannel: () => ok,
	reconnectImChannel: () => ok,
	sendImTestMessage: () => ok,
	testImConnection: () => ok,
	testImConnectionDirect: () => ok,
	updateImChannel: () => ok,

	// ---- Prompts ----
	listPrompts: () => success({ prompts: [] }),
	createPrompt: () => ok,
	updatePrompt: () => ok,
	deletePrompt: () => ok,
	setActivePrompt: () => ok,
	listProjectPrompts: () => success({ prompts: [] }),
	createProjectPrompt: () => ok,
	updateProjectPrompt: () => ok,
	deleteProjectPrompt: () => ok,
	setProjectActivePrompt: () => ok,
};

// 模块导入时自动注入，确保在 App.tsx 等模块加载前 window.look 已就绪
// Vite 在生产构建时会 dead-code-eliminate 整个文件
if (import.meta.env.DEV && typeof window !== "undefined" && !window.look) {
	(window as unknown as Record<string, unknown>).look = mockApi;
	console.log("[Look Mock] 浏览器开发模式：window.look mock 已注入");
}

// 确保 TypeScript 将此文件视为模块（必须有至少一个 export）
export {};
