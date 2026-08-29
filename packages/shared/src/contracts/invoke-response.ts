// ============================================================
// InvokeResponseMap — 响应方向的类型契约
//
// 请求方向（渲染→主）已由 `RendererToMainEvent` 联合体在编译期强制；
// 此前响应方向（主→渲染）只经 `InvokeHandler` 的 `unknown` 返回类型 +
// `ensureIpcEnvelopeShape` 运行时浅校验，改错响应字段名能编译能过测。
//
// 本映射把每个 invoke 事件类型映射到其成功分支的业务载荷（即
// `IpcResult<T>` 的 `T`）。`InvokeHandler<T>` 据此返回
// `IpcResult<InvokeResponse<T>>`，路由器返回错误字段名时编译失败。
//
// 维护规则：
//   - 新增 invoke 事件必须在此追加映射，否则 `InvokeResponse<T>` 退化为
//     `never`，注册处理器时即报类型错（与 ipc-exhaustiveness 测试互为兜底）。
//   - 载荷以路由器实际返回形状为准（ground truth），并应与 `LookAPI`
//     对应方法的 `IpcResult<T>` 声明保持一致；二者漂移时以本映射为准
//     修正 `LookAPI`。
//   - 空载荷用 `Record<string, unknown>`，使成功分支收敛为
//     `{ success: true; error?: never }`，禁止意外夹带业务字段。
// ============================================================

import type {
	AgentDefinitionInfo,
	AgentInfo,
	AvailableModel,
	BrowserPanelState,
	CustomProviderInput,
	Draft,
	ForkedSessionResult,
	GitDiffFile,
	GitRepoInfo,
	McpServerStatusEntry,
	McpToolDto,
	McpToolWithServer,
	NavigateTreeResult,
	PendingAttachment,
	ProjectInfo,
	ProjectPromptDataDto,
	PromptEntry,
	ScheduledTask,
	ScheduledTaskRunLog,
	ScheduledTaskTestResult,
	SessionHistoryPage,
	SkillDiagnostic,
	SkillEntry,
	TestCustomProviderResult,
	UsageData,
	UserProfile,
	UserSettings,
} from "../types.js";
import type {
	ImBindingEntry,
	ImChannelEntry,
	IpcResult,
	LookAPI,
	ProviderSettingsData,
	TranscribeSettingsDto,
	TranscribeState,
} from "./ipc.js";

// ── 自定义 provider 测试结果（成功分支的业务载荷） ──
interface ApiKeyTestResult {
	ok?: boolean;
	skipped?: boolean;
	status?: number;
	error?: string;
	reason?: string;
}

/**
 * 事件类型 → 成功分支业务载荷的映射表。
 *
 * `LookAPI` 里对应方法的 `IpcResult<T>` 声明应当与此一致；此处为路由器
 * 返回值的编译期契约。
 */
export interface InvokeResponseMap {
	// ── agent / session ──
	"agent:send-message": { queued: boolean };
	"agent:remove-queued-message": Record<string, unknown>;
	"agent:insert-queued-message": Record<string, unknown>;
	"agent:activate": Record<string, unknown>;
	"agent:create": { agentId: string; agent?: AgentInfo };
	"agent:destroy": Record<string, unknown>;
	"agent:abort": Record<string, unknown>;
	"agent:switch-model": Record<string, unknown>;
	"agent:update-thinking": Record<string, unknown>;
	"agents:list": { agents?: AgentInfo[] };
	"session:compress": Record<string, unknown>;
	"session:abort-compress": Record<string, unknown>;
	"session:history-page": SessionHistoryPage;
	"agent:rename": Record<string, unknown>;
	"agent:navigate-tree": { result: NavigateTreeResult };
	"agent:create-fork": ForkedSessionResult;

	// ── model ──
	"model:list": { models: AvailableModel[] };

	// ── scheduled tasks ──
	"scheduled-task:list": { tasks: ScheduledTask[] };
	"scheduled-task:create": { task: ScheduledTask };
	"scheduled-task:update": { task: ScheduledTask };
	"scheduled-task:start": { task: ScheduledTask };
	"scheduled-task:pause": { task: ScheduledTask };
	"scheduled-task:delete": Record<string, unknown>;
	"scheduled-task:run-now": { accepted: true };
	"scheduled-task:test": ScheduledTaskTestResult;
	"scheduled-task:logs": { logs: ScheduledTaskRunLog[] };

	// ── drafts ──
	"draft:list": { drafts: Draft[] };
	"draft:create": { draft: Draft };
	"draft:update": { draft: Draft };
	"draft:delete": Record<string, unknown>;

	// ── settings / providers / oauth ──
	"settings:get": ProviderSettingsData;
	"settings:get-api-key": { key: string | null; masked?: boolean };
	"settings:set-api-key": ProviderSettingsData;
	"settings:test-api-key": { result: ApiKeyTestResult };
	"login:prompt-respond": Record<string, unknown>;
	"login:prompt-cancel": Record<string, unknown>;
	"auth:open-oauth-url": { redirectUrl: string };
	"settings:provider-login": ProviderSettingsData;
	"settings:provider-logout": ProviderSettingsData;
	"settings:general:get": { settings?: UserSettings };
	"settings:general:set": { settings?: UserSettings };
	"settings:add-custom-provider": Record<string, unknown>;
	"settings:update-custom-provider": Record<string, unknown>;
	"settings:remove-custom-provider": { removed: boolean };
	"settings:list-custom-providers": { providers: CustomProviderInput[] };
	"settings:test-custom-provider": { result: TestCustomProviderResult };

	// ── prompts ──
	"settings:prompts:list": {
		prompts: PromptEntry[];
		activePromptId: string;
		projectOverrides: Record<string, ProjectPromptDataDto>;
	};
	"settings:prompts:create": { prompt: PromptEntry };
	"settings:prompts:update": { prompt: PromptEntry };
	"settings:prompts:delete": Record<string, unknown>;
	"settings:prompts:set-active": Record<string, unknown>;
	"settings:project-prompts:create": { prompt: PromptEntry };
	"settings:project-prompts:update": { prompt: PromptEntry };
	"settings:project-prompts:delete": Record<string, unknown>;
	"settings:project-prompts:set-active": Record<string, unknown>;

	// ── skills ──
	"skills:list": {
		skills?: SkillEntry[];
		diagnostics?: SkillDiagnostic[];
		importedPaths?: string[];
	};
	"skills:import-paths": { importedCount: number };
	"skills:detect-common": {
		detected?: Array<{ tool: string; path: string; exists: boolean; skillCount: number }>;
	};
	"skills:set-enabled": Record<string, unknown>;

	// ── dialogs / shell / window ──
	"dialog:open-directory": { path?: string; canceled?: boolean };
	"dialog:open-files": { paths?: string[]; canceled?: boolean };
	"shell:reveal-in-finder": Record<string, unknown>;
	"shell:open-project-folder": { path?: string };
	"window:set-traffic-light-center": Record<string, unknown>;

	// ── projects ──
	"project:list": { projects: ProjectInfo[]; activeProjectId?: string | null };
	"project:create": { project: ProjectInfo; isDuplicate: boolean };
	"project:switch": Record<string, unknown>;
	"project:rename": Record<string, unknown>;
	"project:delete": Record<string, unknown>;
	"project:confirm-delete-response": Record<string, unknown>;
	"project:git-info": { info: GitRepoInfo | null };
	"project:git-diff": { files: GitDiffFile[] };
	"project:git-file-head": { content: string | null };
	"git:file-head": { content: string | null };

	// ── user profile / usage ──
	"user-profile:get": { profile: UserProfile | null };
	"user-profile:update": Record<string, unknown>;
	"user-profile:logout": Record<string, unknown>;
	"usage:get": { usage: UsageData };

	// ── shared area ──
	"shared:list": { nodes?: import("../types.js").FileTreeNode[] };
	"shared:list-children": { nodes?: import("../types.js").FileTreeNode[] };
	"shared:watch": Record<string, unknown>;
	"shared:unwatch": Record<string, unknown>;
	"shared:write": Record<string, unknown>;
	"shared:mkdir": Record<string, unknown>;
	"shared:delete": Record<string, unknown>;
	"shared:import": Record<string, unknown>;
	"shared:export": Record<string, unknown>;
	"shared:write-content": Record<string, unknown>;

	// ── workspace tree ──
	"workspace:list-children": { nodes?: import("../types.js").FileTreeNode[] };
	"workspace:watch": Record<string, unknown>;
	"workspace:unwatch": Record<string, unknown>;

	// ── file content ──
	"file:read":
		| { kind: "text"; content: string; truncated: boolean; sizeBytes: number; inProject: boolean }
		| { kind: "image"; data: string; mimeType: string; sizeBytes: number; inProject: boolean }
		| { kind: "binary"; sizeBytes: number; inProject: boolean };
	"file:write": { sizeBytes: number };
	"file:stat": { kind: "file" | "directory" | "other" | "missing"; inProject: boolean };

	// ── attachments ──
	"attachment:create": { attachment: PendingAttachment };
	"attachment:read": { content: string; sizeBytes: number };
	"attachment:update": { sizeBytes: number };
	"attachment:delete": Record<string, unknown>;
	"attachment:resolve": { path: string };
	"attachment:import": { attachment: PendingAttachment };

	// ── file viewer window ──
	"fileViewer:open": Record<string, unknown>;
	"fileViewer:ready": { path?: string | null; diffPatch?: string | null };
	"fileViewer:dock": Record<string, unknown>;
	"fileViewer:dock-result": Record<string, unknown>;

	// ── permission / plan ──
	"permission:set-mode": { mode?: import("../types.js").PermissionMode };
	"permission:get-mode": { mode?: import("../types.js").PermissionMode };
	"permission:respond": Record<string, unknown>;
	"plan:question-respond": Record<string, unknown>;
	"plan:approval-respond": Record<string, unknown>;

	// ── subagent / agent definitions ──
	"agent:set-subagent-enabled": { enabled?: boolean };
	"agent:review-changes": { childSessionId: string | null; title: string };
	"agent-definitions:list": { agents?: AgentDefinitionInfo[] };
	"agent-definitions:create": { agent?: AgentDefinitionInfo };
	"agent-definitions:update": { agent?: AgentDefinitionInfo };
	"agent-definitions:delete": Record<string, unknown>;
	"agent-definitions:set-enabled": Record<string, unknown>;

	// ── IM ──
	"im:get-channels": { channels?: ImChannelEntry[] };
	"im:connect-feishu": { registrationId?: string };
	"im:connect-feishu-manual": Record<string, unknown>;
	"im:cancel-registration": Record<string, unknown>;
	"im:disconnect-channel": Record<string, unknown>;
	"im:remove-channel": Record<string, unknown>;
	"im:reconnect-channel": Record<string, unknown>;
	"im:test-connection": { message?: string };
	"im:test-connection-direct": { message?: string };
	"im:update-channel": Record<string, unknown>;
	"im:get-bindings": { bindings?: ImBindingEntry[] };

	// ── MCP ──
	"mcp:list-servers": { servers: McpServerStatusEntry[] };
	"mcp:add-server": Record<string, unknown>;
	"mcp:remove-server": Record<string, unknown>;
	"mcp:test-server": { tools?: McpToolDto[] };
	"mcp:list-tools": { tools: McpToolDto[] };
	"mcp:toggle-server": Record<string, unknown>;
	"mcp:list-all-tools": { tools?: McpToolWithServer[] };
	"mcp:update-server": Record<string, unknown>;

	// ── auto updater ──
	"update:check": Record<string, unknown>;
	"update:download": Record<string, unknown>;
	"update:install": Record<string, unknown>;

	// ── browser panel ──
	"browser:get-state": { state: BrowserPanelState };
	"browser:panel-action": Record<string, unknown>;
	"browser:open-panel": Record<string, unknown>;
	"browser:close-panel": Record<string, unknown>;
	"browser:set-layout": Record<string, unknown>;

	// ── 语音助手（本地转写）──
	"transcribe:get-state": { state: TranscribeState };
	"transcribe:set-settings": { settings: TranscribeSettingsDto };
	"transcribe:download-model": { ok: boolean };
	"transcribe:delete-model": { ok: boolean };
	"transcribe:record-start": { ok: boolean };
	"transcribe:record-stop": { text: string; seconds: number };
	"transcribe:record-state": {
		recording: boolean;
		rms: number;
		streaming: boolean;
		committed: string;
		tentative: string;
	};
}

/**
 * 事件类型 → 成功分支业务载荷。
 *
 * 未在 `InvokeResponseMap` 中登记的事件退化为 `never`，使
 * `InvokeHandler<T>` 的返回类型不可满足，强制新增事件必须补映射。
 */
export type InvokeResponse<T extends keyof InvokeResponseMap = keyof InvokeResponseMap> =
	T extends keyof InvokeResponseMap ? InvokeResponseMap[T] : never;

/**
 * 处理器返回的完整信封类型。路由器以此声明返回值，编译期即校验
 * 成功分支的业务字段与 `InvokeResponseMap` 一致。
 */
export type InvokeResult<T extends keyof InvokeResponseMap> = IpcResult<InvokeResponse<T>>;

// ============================================================
// 编译期自检（零运行时产物，由 shared 的 typecheck 强制）
//
// 1. 键穷尽：InvokeResponseMap 键必须与 `RendererToMainEvent` 联合体完全一致。
// 2. LookAPI ↔ 映射 全量漂移检查：`LookApiMethodEventMap` 显式登记每个
//    invoke 方法对应的事件类型；`_AssertAllMethods` 对其逐一断言成功载荷
//    与 `InvokeResponseMap` 一致。任一方法漏登记（键穷尽）、载荷漂移
//    （_Eq 不成立）或事件漏映射，typecheck 即报错。
//
// 不再抽样——全部方法参与断言。
// ============================================================

import type { RendererToMainEvent } from "../types/events/renderer-to-main.js";

/** 断言 T 恰为 never（用于穷尽性：多余/缺失键 → 非 never → 不满足约束 → 报错）。 */
type _AssertNever<T extends never> = T;

type _MissingFromMap = Exclude<RendererToMainEvent["type"], keyof InvokeResponseMap>;
type _ExtraInMap = Exclude<keyof InvokeResponseMap, RendererToMainEvent["type"]>;
type _X_Missing = _AssertNever<_MissingFromMap>;
type _X_Extra = _AssertNever<_ExtraInMap>;

type _SuccessPayload<F extends (...args: never[]) => unknown> = ReturnType<F> extends Promise<infer R>
	? R extends { success: false; error: string; errorCode?: string | null }
		? never
		: Omit<R, "success" | "error" | "errorCode">
	: never;

type _Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * LookAPI invoke 方法名 → RendererToMain 事件类型 的显式登记表。
 *
 * 这是三处契约（LookAPI / RendererToMainEvent / InvokeResponseMap）之间
 * 唯一的"名字对应"来源：新增方法不登记 → 键穷尽报错；登记的事件不存在 →
 * 键穷尽报错；载荷漂移 → 全量断言报错。
 */
export interface LookApiMethodEventMap {
	// ── agent / session ──
	sendMessage: "agent:send-message";
	removeQueuedMessage: "agent:remove-queued-message";
	insertQueuedMessage: "agent:insert-queued-message";
	activateSession: "agent:activate";
	createAgent: "agent:create";
	destroyAgent: "agent:destroy";
	abortAgent: "agent:abort";
	switchModel: "agent:switch-model";
	updateThinking: "agent:update-thinking";
	getAgents: "agents:list";
	compressSession: "session:compress";
	abortCompressSession: "session:abort-compress";
	loadHistoryPage: "session:history-page";
	renameAgent: "agent:rename";
	navigateTree: "agent:navigate-tree";
	createFork: "agent:create-fork";

	// ── model ──
	getModels: "model:list";

	// ── scheduled tasks ──
	listScheduledTasks: "scheduled-task:list";
	createScheduledTask: "scheduled-task:create";
	updateScheduledTask: "scheduled-task:update";
	startScheduledTask: "scheduled-task:start";
	pauseScheduledTask: "scheduled-task:pause";
	deleteScheduledTask: "scheduled-task:delete";
	runScheduledTaskNow: "scheduled-task:run-now";
	testScheduledTask: "scheduled-task:test";
	listScheduledTaskLogs: "scheduled-task:logs";

	// ── drafts ──
	listDrafts: "draft:list";
	createDraft: "draft:create";
	updateDraft: "draft:update";
	deleteDraft: "draft:delete";

	// ── settings / providers / oauth ──
	getSettings: "settings:get";
	getApiKey: "settings:get-api-key";
	setApiKey: "settings:set-api-key";
	testApiKey: "settings:test-api-key";
	respondLoginPrompt: "login:prompt-respond";
	cancelLoginPrompt: "login:prompt-cancel";
	openOAuthUrl: "auth:open-oauth-url";
	providerLogin: "settings:provider-login";
	providerLogout: "settings:provider-logout";
	getGeneralSettings: "settings:general:get";
	setGeneralSettings: "settings:general:set";
	addCustomProvider: "settings:add-custom-provider";
	updateCustomProvider: "settings:update-custom-provider";
	removeCustomProvider: "settings:remove-custom-provider";
	listCustomProviders: "settings:list-custom-providers";
	testCustomProvider: "settings:test-custom-provider";

	// ── prompts ──
	listPrompts: "settings:prompts:list";
	createPrompt: "settings:prompts:create";
	updatePrompt: "settings:prompts:update";
	deletePrompt: "settings:prompts:delete";
	setActivePrompt: "settings:prompts:set-active";
	createProjectPrompt: "settings:project-prompts:create";
	updateProjectPrompt: "settings:project-prompts:update";
	deleteProjectPrompt: "settings:project-prompts:delete";
	setProjectActivePrompt: "settings:project-prompts:set-active";

	// ── skills ──
	listSkills: "skills:list";
	importSkillPaths: "skills:import-paths";
	detectCommonSkillPaths: "skills:detect-common";
	setSkillEnabled: "skills:set-enabled";

	// ── dialogs / shell / window ──
	openDirectoryDialog: "dialog:open-directory";
	openFileDialog: "dialog:open-files";
	revealInFinder: "shell:reveal-in-finder";
	openProjectFolder: "shell:open-project-folder";
	setTrafficLightCenter: "window:set-traffic-light-center";

	// ── projects ──
	listProjects: "project:list";
	createProject: "project:create";
	switchProject: "project:switch";
	renameProject: "project:rename";
	deleteProject: "project:delete";
	confirmDeleteProject: "project:confirm-delete-response";
	getProjectGitInfo: "project:git-info";
	getProjectGitDiff: "project:git-diff";
	getProjectGitFileHead: "project:git-file-head";
	getGitFileHead: "git:file-head";

	// ── user profile / usage ──
	getUserProfile: "user-profile:get";
	updateUserProfile: "user-profile:update";
	logout: "user-profile:logout";
	getUsage: "usage:get";

	// ── shared area ──
	listSharedFiles: "shared:list";
	listSharedChildren: "shared:list-children";
	startSharedWatch: "shared:watch";
	stopSharedWatch: "shared:unwatch";
	writeSharedFile: "shared:write";
	createSharedDir: "shared:mkdir";
	deleteSharedItem: "shared:delete";
	importToShared: "shared:import";
	exportFromShared: "shared:export";
	writeSharedContent: "shared:write-content";

	// ── workspace tree ──
	listWorkspaceChildren: "workspace:list-children";
	startWorkspaceWatch: "workspace:watch";
	stopWorkspaceWatch: "workspace:unwatch";

	// ── file content ──
	readFileContent: "file:read";
	writeFileContent: "file:write";
	statFilePath: "file:stat";

	// ── attachments ──
	createAttachment: "attachment:create";
	readAttachment: "attachment:read";
	updateAttachment: "attachment:update";
	deleteAttachment: "attachment:delete";
	resolveAttachmentPath: "attachment:resolve";
	importAttachment: "attachment:import";

	// ── file viewer window ──
	openFileViewer: "fileViewer:open";
	fileViewerReady: "fileViewer:ready";
	dockFileViewer: "fileViewer:dock";
	resolveFileViewerDock: "fileViewer:dock-result";

	// ── permission / plan ──
	setPermissionMode: "permission:set-mode";
	getPermissionMode: "permission:get-mode";
	respondPermission: "permission:respond";
	respondPlanQuestion: "plan:question-respond";
	respondPlanApproval: "plan:approval-respond";

	// ── subagent / agent definitions ──
	setSubagentEnabled: "agent:set-subagent-enabled";
	reviewChanges: "agent:review-changes";
	listAgentDefinitions: "agent-definitions:list";
	createAgentDefinition: "agent-definitions:create";
	updateAgentDefinition: "agent-definitions:update";
	deleteAgentDefinition: "agent-definitions:delete";
	setAgentDefinitionEnabled: "agent-definitions:set-enabled";

	// ── IM ──
	getImChannels: "im:get-channels";
	connectFeishuChannel: "im:connect-feishu";
	connectFeishuManualChannel: "im:connect-feishu-manual";
	cancelFeishuRegistration: "im:cancel-registration";
	disconnectImChannel: "im:disconnect-channel";
	removeImChannel: "im:remove-channel";
	reconnectImChannel: "im:reconnect-channel";
	testImConnection: "im:test-connection";
	testImConnectionDirect: "im:test-connection-direct";
	updateImChannel: "im:update-channel";
	getImBindings: "im:get-bindings";

	// ── MCP ──
	listMcpServers: "mcp:list-servers";
	addMcpServer: "mcp:add-server";
	removeMcpServer: "mcp:remove-server";
	testMcpServer: "mcp:test-server";
	listMcpTools: "mcp:list-tools";
	toggleMcpServer: "mcp:toggle-server";
	listAllMcpTools: "mcp:list-all-tools";
	updateMcpServer: "mcp:update-server";

	// ── auto updater ──
	checkForUpdates: "update:check";
	downloadUpdate: "update:download";
	installUpdate: "update:install";

	// ── browser panel ──
	getBrowserPanelState: "browser:get-state";
	browserPanelAction: "browser:panel-action";
	openBrowserPanel: "browser:open-panel";
	closeBrowserPanel: "browser:close-panel";
	setAgentBrowserLayout: "browser:set-layout";

	// ── 语音助手（本地转写）──
	transcribeGetState: "transcribe:get-state";
	transcribeSetSettings: "transcribe:set-settings";
	transcribeDownloadModel: "transcribe:download-model";
	transcribeDeleteModel: "transcribe:delete-model";
	transcribeRecordStart: "transcribe:record-start";
	transcribeRecordStop: "transcribe:record-stop";
	transcribeRecordState: "transcribe:record-state";
}

/** LookAPI 中所有 invoke 方法（返回 Promise<IpcResult> 的成员）。 */
type _InvokeMethods = {
	[K in keyof LookAPI]: LookAPI[K] extends (...args: never[]) => Promise<IpcResult> ? K : never;
}[keyof LookAPI];

/** 方法登记表必须与 LookAPI 的 invoke 方法集合双向穷尽。 */
type _UnmappedMethods = Exclude<_InvokeMethods, keyof LookApiMethodEventMap>;
type _GhostMappedMethods = Exclude<keyof LookApiMethodEventMap, _InvokeMethods>;
type _X_Unmapped = _AssertNever<_UnmappedMethods>;
type _X_Ghost = _AssertNever<_GhostMappedMethods>;

/**
 * 全量载荷断言 + 漂移定位：对每个登记方法校验 LookAPI 成功载荷与
 * InvokeResponseMap 一致。不一致的方法名进入集合，断言为 never——
 * 报错时错误信息会直接列出具体的方法名，便于定位。
 */
type _FailingMethods = {
	[K in keyof LookApiMethodEventMap]: _Eq<
		_SuccessPayload<LookAPI[K]>,
		InvokeResponseMap[LookApiMethodEventMap[K]]
	> extends true
		? never
		: K;
}[keyof LookApiMethodEventMap];
type _X_Failing = _AssertNever<_FailingMethods>;

// 汇总导出：引用全部断言别名，确保它们参与类型计算（未引用的别名不会被求值）。
export type _InvokeResponseContractGuard = [_X_Missing, _X_Extra, _X_Unmapped, _X_Ghost, _X_Failing];
