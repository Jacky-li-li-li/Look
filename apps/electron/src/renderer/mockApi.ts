// ============================================================
// mockApi — 浏览器开发模式下的 window.look mock
//
// 当在浏览器中（非 Electron 环境）访问 Vite 开发服务器时，
// window.look 不存在。此 mock 提供最小化的 API 实现，
// 让渲染层能独立运行以便前端开发调试。
// ============================================================

import type { IpcResult, LookAPI } from "@shared/contracts/ipc";
import type { MainToRendererEvent, ScheduledTask } from "@shared/types";

const noop = () => {};

const mockScenario = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("mock") : null;
const mockTone =
	typeof window !== "undefined" && new URLSearchParams(window.location.search).get("theme") === "light"
		? "light"
		: "dark";
const MOCK_SESSION_ID = "dev-chat-session";
let mockSnapshotSequence = 0;

/** 泛型成功响应 */
function success<T extends object>(data: T): Promise<IpcResult<T>> {
	return Promise.resolve({ success: true, ...data });
}

/** 空成功响应 */
const ok = Promise.resolve({ success: true }) as Promise<IpcResult>;

/** IPC 事件监听器 */
const listeners = new Set<(event: MainToRendererEvent) => void>();

const mockUsage = {
	input: 640,
	output: 420,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1060,
	cost: { input: 0.0012, output: 0.0028, cacheRead: 0, cacheWrite: 0, total: 0.004 },
};

let mockEntries: unknown[] = [
	{
		type: "message",
		id: "mock-user-1",
		parentId: null,
		timestamp: new Date(Date.now() - 12_000).toISOString(),
		message: {
			role: "user",
			content: [{ type: "text", text: "检查消息排版，并给我一个包含代码和表格的简短示例。" }],
			timestamp: Date.now() - 12_000,
		},
	},
	{
		type: "message",
		id: "mock-assistant-1",
		parentId: "mock-user-1",
		timestamp: new Date(Date.now() - 10_000).toISOString(),
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "先检查信息层级、行长和代码块的可读性。" },
				{
					type: "toolCall",
					id: "mock-tool-1",
					name: "read",
					arguments: { path: "src/renderer/App.css", line_start: 505, line_end: 610 },
				},
				{
					type: "text",
					text: '## 消息渲染示例\n\n正文应该保持稳定的阅读节奏，并支持 `inline code`、[链接](https://example.com) 与文件引用 @src/renderer/App.css。\n\n| 项目 | 状态 |\n| --- | --- |\n| Markdown | 正常 |\n| 流式光标 | 待验证 |\n\n```\n┌────────────────────────┐\n│ Renderer (React)       │\n├────────────────────────┤\n│ Main Process (Electron)│\n└────────────────────────┘\n```\n\n```typescript\napp.on("before-quit", async () => schedulerService?.dispose()); // abort active runs and release timers safely\n```\n\n> 动效应提示状态，而不是抢夺注意力。\n\n```mermaid\ngraph LR\n  A[Markdown] --> B[稳定渲染]\n```',
				},
			],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			usage: mockUsage,
			stopReason: "stop",
			timestamp: Date.now() - 10_000,
		},
	},
	{
		type: "message",
		id: "mock-tool-result-1",
		parentId: "mock-assistant-1",
		timestamp: new Date(Date.now() - 9_000).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: "mock-tool-1",
			toolName: "read",
			content: [{ type: "text", text: "Loaded message typography styles." }],
			isError: false,
			timestamp: Date.now() - 9_000,
		},
	},
];

function emit(event: MainToRendererEvent): void {
	for (const listener of listeners) listener(event);
}

function mockRuntime() {
	return {
		thinkingLevel: "medium",
		isStreaming: false,
		isRetrying: false,
		isCompacting: false,
		retryAttempt: 0,
		steering: [],
		followUp: [],
		stats: {},
		contextUsage: { tokens: 12_480, contextWindow: 128_000, percent: 9.75 },
	};
}

function emitMockSnapshot(reason: "activate" | "agent_end" = "activate"): void {
	// DEV-only mock：entries/runtime 用 unknown 填充，绕过会话快照的完整类型约束
	emit({
		type: "session:snapshot",
		sessionId: MOCK_SESSION_ID,
		reason,
		sequence: ++mockSnapshotSequence,
		leafId: "mock-assistant-1",
		entries: mockEntries,
		runtime: mockRuntime(),
	} as unknown as MainToRendererEvent);
}

function emitUiEvents(events: unknown[]): void {
	emit({ type: "session:ui-event", sessionId: MOCK_SESSION_ID, events } as unknown as MainToRendererEvent);
}

function runMockStream(message: string): void {
	const now = Date.now();
	const response =
		"流式文本现在会保持同一个渲染节点，列表与代码块逐步出现时不应闪烁。\n\n- 自动跟随仅在用户位于底部时发生\n- 用户向上滚动后不抢回滚动位置\n- 完成后平滑切换为持久消息";
	const chunks = response.match(/.{1,9}/gu) ?? [response];
	emitUiEvents([
		{ type: "run_status", status: "streaming", timestamp: now },
		{ type: "user_message", text: message, timestamp: now + 1 },
		{ type: "assistant_message_start", timestamp: now + 2 },
		{ type: "thinking_start", contentIndex: 0, timestamp: now + 3 },
	]);
	setTimeout(
		() =>
			emitUiEvents([
				{
					type: "thinking_delta",
					contentIndex: 0,
					delta: "检查流式布局稳定性与自动滚动策略…",
					timestamp: Date.now(),
				},
			]),
		120,
	);
	setTimeout(
		() =>
			emitUiEvents([
				{
					type: "thinking_end",
					contentIndex: 0,
					thinking: "检查流式布局稳定性与自动滚动策略…",
					timestamp: Date.now(),
				},
				{ type: "assistant_text_start", contentIndex: 1, timestamp: Date.now() },
			]),
		360,
	);
	chunks.forEach((delta, index) => {
		setTimeout(
			() => emitUiEvents([{ type: "assistant_text_delta", contentIndex: 1, delta, timestamp: Date.now() }]),
			520 + index * 85,
		);
	});
	const doneAt = 620 + chunks.length * 85;
	setTimeout(() => {
		emitUiEvents([
			{ type: "assistant_text_end", contentIndex: 1, text: response, timestamp: Date.now() },
			{ type: "assistant_message_end", completed: true, timestamp: Date.now() },
		]);
	}, doneAt);
	setTimeout(() => {
		const userId = `mock-user-${Date.now()}`;
		const assistantId = `mock-assistant-${Date.now()}`;
		mockEntries = [
			...mockEntries,
			{
				type: "message",
				id: userId,
				parentId: "mock-assistant-1",
				timestamp: new Date().toISOString(),
				message: { role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() },
			},
			{
				type: "message",
				id: assistantId,
				parentId: userId,
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "检查流式布局稳定性与自动滚动策略…" },
						{ type: "text", text: response },
					],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5",
					usage: mockUsage,
					stopReason: "stop",
					timestamp: Date.now(),
				},
			},
		];
		emitUiEvents([{ type: "run_status", status: "idle", timestamp: Date.now() }]);
		emitMockSnapshot("agent_end");
	}, doneAt + 180);
}

const mockApi: LookAPI = {
	homedir: "",
	platform: "darwin",

	send: noop,

	invoke: () => Promise.resolve({ success: true }),

	onEvent: (callback: (event: MainToRendererEvent) => void) => {
		listeners.add(callback);
		// 模拟主进程就绪：让 waitForAppReady 立即放行，避免 mock 模式
		// 白白等待 2s 超时（mock 的 invoke 恒成功，无需真实就绪信号）。
		queueMicrotask(() => {
			callback({ type: "app:ready" } as MainToRendererEvent);
		});
		return () => {
			listeners.delete(callback);
		};
	},

	// ---- Agent ----
	sendMessage: (
		_agentId: string,
		message: string,
		_images?: import("@shared/types").ImageContent[],
		_sendMode?: "steer" | "followUp",
	) => {
		if (mockScenario === "chat") runMockStream(message);
		return ok;
	},
	removeQueuedMessage: () => ok,
	insertQueuedMessage: () => ok,
	activateSession: (sessionId: string) => {
		if (mockScenario === "chat" && sessionId === MOCK_SESSION_ID) queueMicrotask(() => emitMockSnapshot());
		return ok;
	},
	createAgent: () => success({ agentId: MOCK_SESSION_ID }),
	destroyAgent: () => ok,
	abortAgent: () => ok,
	switchModel: () => ok,
	updateThinking: () => ok,
	renameAgent: () => ok,
	compressSession: () => ok,

	// ---- Model ----
	getModels: () => success({ models: [] }),

	// ---- Scheduled tasks ----
	listScheduledTasks: () => success({ tasks: [] }),
	createScheduledTask: () => success({ task: null as unknown as ScheduledTask }),
	updateScheduledTask: () => success({ task: null as unknown as ScheduledTask }),
	startScheduledTask: () => success({ task: null as unknown as ScheduledTask }),
	pauseScheduledTask: () => success({ task: null as unknown as ScheduledTask }),
	resumeScheduledTask: () => success({ task: null as unknown as ScheduledTask }),
	deleteScheduledTask: () => ok,
	runScheduledTaskNow: () => success({ accepted: true }),
	testScheduledTask: () =>
		success({
			log: {
				id: "mock-test-run",
				taskId: "mock-test-task",
				taskName: "Test task",
				scheduledAt: new Date().toISOString(),
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
				status: "success",
				attempt: 1,
				maxAttempts: 1,
				output: "Test completed",
				ownerId: "mock",
			},
		}),
	listScheduledTaskLogs: () => success({ logs: [] }),
	validateCron: () => success({ valid: true }),
	getProviders: () => success({ providers: [] }),

	// ---- Agents ----
	getAgents: () =>
		success({
			agents:
				mockScenario === "chat"
					? [
							{
								id: MOCK_SESSION_ID,
								name: "前端体验审计",
								model: "openai/gpt-5",
								thinkingLevel: "medium",
								isStreaming: false,
								isRetrying: false,
								isCompacting: false,
								messageCount: mockEntries.length,
								createdAt: Date.now() - 60_000,
								projectId: "dev-browser",
							},
						]
					: [],
		}),

	// ---- Settings ----
	getSettings: () =>
		success({
			providers: [],
			customProviders: [],
			customStats: { configured: 0, totalModels: 0 },
		}),
	getApiKey: (_provider?: string, _opts?: { reveal?: boolean }) => success({ key: "", masked: false }),
	testApiKey: () => Promise.resolve({ success: true, result: { ok: true } }),
	testEnvKey: () => success({ result: {} }),
	setApiKey: () => success({ providers: [], customProviders: [], customStats: { configured: 0, totalModels: 0 } }),
	getGeneralSettings: () =>
		success({
			settings: (mockScenario === "chat"
				? { openedSessionIds: [MOCK_SESSION_ID], themeTone: mockTone }
				: {}) as unknown as import("@shared/types").UserSettings,
		}),
	setGeneralSettings: () => ok,
	resetGeneralSettings: () => ok,

	// ---- Custom providers ----
	addCustomProvider: () => ok,
	updateCustomProvider: () => ok,
	removeCustomProvider: () => success({ removed: true }),
	listCustomProviders: () => success({ providers: [] }),
	testCustomProvider: () => success({ result: {} as unknown as import("@shared/types").TestCustomProviderResult }),

	// ---- Skills ----
	listSkills: () => success({ skills: [] }),
	importSkillPaths: () => Promise.resolve({ success: true, importedCount: 0 }),
	detectCommonSkillPaths: () => success({ paths: [] }),

	// ---- MCP ----
	listAllMcpTools: () => success({ tools: [] }),
	listMcpServers: () => success({ servers: [] }),
	listMcpTools: () => success({ tools: [] }),
	addMcpServer: () => ok,
	removeMcpServer: () => ok,
	testMcpServer: () => success({ tools: [] }),
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
	createProject: () =>
		success({
			project: {
				id: "dev-browser",
				name: "pi (浏览器预览)",
				cwd: "/Users/jacky/Desktop/pi",
				createdAt: Date.now(),
				valid: true,
			},
			isDuplicate: false,
		}),
	switchProject: () => ok,
	renameProject: () => ok,
	deleteProject: () => ok,
	confirmDeleteProject: () => ok,
	getActiveProject: () => success({ project: null }),
	// 浏览器 dev 模式返回固定假 git 信息，便于预览状态栏（真实环境由主进程探测）。
	getProjectGitInfo: () =>
		success({
			info: {
				isRepo: true,
				repoRoot: "/mock/project",
				branch: "main",
				headShort: null,
				remoteName: "origin",
				remoteUrl: "https://github.com/mock/repo.git",
			},
		}),

	// ---- Session tree ----
	navigateTree: () => success({ result: { cancelled: true } }),
	createFork: () => success({ agentId: MOCK_SESSION_ID, sessionFilePath: "" }),
	setEntryLabel: () => ok,

	// ---- Shared area ----
	listSharedFiles: () => success({ nodes: [] }),
	startSharedWatch: () => ok,
	stopSharedWatch: () => ok,
	writeSharedFile: () => ok,
	createSharedDir: () => ok,
	deleteSharedItem: () => ok,
	importToShared: () => ok,
	exportFromShared: () => ok,
	writeSharedContent: () => ok,

	// ---- Workspace tree ----
	listWorkspaceChildren: () => success({ nodes: [] }),
	statWorkspaceNode: () => success({ node: null }),
	startWorkspaceWatch: () => ok,
	stopWorkspaceWatch: () => ok,

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
	// 返回非空 mock profile，使浏览器 mock 模式能进入主界面（否则被登录页拦截）。
	getUserProfile: () =>
		success({
			profile: {
				userId: "mock-user",
				email: "mock@look.local",
				userName: "Mock Dev",
				avatar: "",
			},
		}),
	updateUserProfile: () => ok,
	resetUserProfile: () => ok,
	logout: () => ok,

	// ---- Usage ----
	getUsage: () => success({ usage: { usage: {}, modelCost: {}, modelUsage: {}, years: [] } }),

	// ---- IM Channels ----
	getImChannels: () => success({ channels: [] }),
	getImBindings: () => success({ bindings: [] }),
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

	// ---- 补齐的 LookAPI 契约方法（DEV mock 桩，与 preload 保持同构） ----
	abortCompressSession: () => ok,
	getLookIslandSettings: () => Promise.resolve({ success: true }),
	setLookIslandEnabled: () => Promise.resolve({ success: true }),
	openOAuthUrl: () => success({ redirectUrl: "" }),
	readFileContent: () => success({ kind: "binary", sizeBytes: 0 }),
	writeFileContent: () => success({ sizeBytes: 0 }),
	statFilePath: () => success({ kind: "missing" }),
	openFileViewer: () => Promise.resolve({ success: true }),
	fileViewerReady: () => Promise.resolve({ success: true, path: null }),
	providerLogin: () => success({ providers: [], customProviders: [], customStats: { configured: 0, totalModels: 0 } }),
	respondLoginPrompt: () => ok,
	cancelLoginPrompt: () => ok,
	providerLogout: () =>
		success({ providers: [], customProviders: [], customStats: { configured: 0, totalModels: 0 } }),
	checkForUpdates: () => Promise.resolve({ success: true }),
	downloadUpdate: () => Promise.resolve({ success: true }),
	installUpdate: () => Promise.resolve({ success: true }),
};

// 模块导入时自动注入，确保在 App.tsx 等模块加载前 window.look 已就绪
// Vite 在生产构建时会 dead-code-eliminate 整个文件
if (import.meta.env.DEV && typeof window !== "undefined" && !window.look) {
	(window as unknown as Record<string, unknown>).look = mockApi;
	console.log("[Look Mock] 浏览器开发模式：window.look mock 已注入");
}
