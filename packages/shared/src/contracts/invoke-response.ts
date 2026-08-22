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
	NavigateTreeResult,
	PendingAttachment,
	ProjectInfo,
	ProviderInfo,
	ScheduledTask,
	ScheduledTaskRunLog,
	ScheduledTaskTestResult,
	SessionHistoryPage,
	TestCustomProviderResult,
	UserProfile,
	UserSettings,
} from "../types.js";
import type { IpcResult, LookAPI, ProviderSettingsData } from "./ipc.js";

// ── 自定义 provider 测试结果（成功分支的业务载荷） ──
interface ApiKeyTestResult {
	ok?: boolean;
	skipped?: boolean;
	status?: number;
	error?: string;
	reason?: string;
}

/** `settings:prompts:list` 返回的活动 prompt 标记（与全局跟随约定同源）。 */
interface PromptsListPayload {
	prompts: unknown[];
	activePromptId: string;
	projectOverrides: Record<string, unknown>;
}

interface ProjectPromptsListPayload {
	prompts: unknown[];
	activePromptId: string;
}

/** MCP 工具条目（router 返回的最小形状，与 `LookAPI.listAllMcpTools` 一致）。 */
interface McpToolEntry {
	server: string;
	tool: { name: string; description?: string };
}

/** IM 渠道条目（与 `LookAPI.getImChannels` 内联声明一致）。 */
interface ImChannelEntry {
	provider: string;
	appId: string;
	name?: string;
	status: string;
	connected: boolean;
	enabled: boolean;
	error?: string;
}

/** IM 绑定条目（与 `LookAPI.getImBindings` 内联声明一致）。 */
interface ImBindingEntry {
	chatId: string;
	sessionId: string;
	projectId: string;
	createdAt: number;
	appId?: string;
	chatType?: "p2p" | "group";
	senderOpenId?: string;
	peerName?: string;
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
	"agent:set-entry-label": Record<string, unknown>;

	// ── model ──
	"model:list": { models: AvailableModel[] };
	"model:providers": { providers: ProviderInfo[] };

	// ── scheduled tasks ──
	"scheduled-task:list": { tasks: ScheduledTask[] };
	"scheduled-task:create": { task: ScheduledTask };
	"scheduled-task:update": { task: ScheduledTask };
	"scheduled-task:start": { task: ScheduledTask };
	"scheduled-task:pause": { task: ScheduledTask };
	"scheduled-task:resume": { task: ScheduledTask };
	"scheduled-task:delete": Record<string, unknown>;
	"scheduled-task:run-now": { accepted: true };
	"scheduled-task:test": ScheduledTaskTestResult;
	"scheduled-task:logs": { logs: ScheduledTaskRunLog[] };
	"scheduled-task:validate-cron": { valid: boolean; nextRunAt?: string };

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
	"settings:test-env-key": { result: ApiKeyTestResult };
	"login:prompt-respond": Record<string, unknown>;
	"login:prompt-cancel": Record<string, unknown>;
	"auth:open-oauth-url": { redirectUrl: string };
	"settings:provider-login": ProviderSettingsData;
	"settings:provider-logout": ProviderSettingsData;
	"settings:general:get": { settings?: UserSettings };
	"settings:general:set": { settings?: UserSettings };
	"settings:general:reset": { settings?: UserSettings };
	"settings:add-custom-provider": Record<string, unknown>;
	"settings:update-custom-provider": Record<string, unknown>;
	"settings:remove-custom-provider": { removed: boolean };
	"settings:list-custom-providers": { providers: CustomProviderInput[] };
	"settings:test-custom-provider": { result: TestCustomProviderResult };

	// ── prompts ──
	"settings:prompts:list": PromptsListPayload;
	"settings:prompts:create": { prompt: unknown };
	"settings:prompts:update": { prompt: unknown };
	"settings:prompts:delete": Record<string, unknown>;
	"settings:prompts:set-active": Record<string, unknown>;
	"settings:project-prompts:list": ProjectPromptsListPayload;
	"settings:project-prompts:create": { prompt: unknown };
	"settings:project-prompts:update": { prompt: unknown };
	"settings:project-prompts:delete": Record<string, unknown>;
	"settings:project-prompts:set-active": Record<string, unknown>;

	// ── skills ──
	"skills:list": {
		skills?: unknown[];
		diagnostics?: unknown[];
		importedPaths?: string[];
	};
	"skills:import-paths": { importedCount: number };
	"skills:detect-common": {
		detected?: Array<{ tool: string; path: string; exists: boolean; skillCount: number }>;
	};
	"skills:set-enabled": Record<string, unknown>;

	// ── dialogs / shell ──
	"dialog:open-directory": { path?: string; canceled?: boolean };
	"dialog:open-files": { paths?: string[]; canceled?: boolean };
	"shell:reveal-in-finder": Record<string, unknown>;
	"shell:open-project-folder": { path?: string };

	// ── projects ──
	"project:list": { projects: ProjectInfo[]; activeProjectId?: string | null };
	"project:create": { project: ProjectInfo; isDuplicate: boolean };
	"project:switch": Record<string, unknown>;
	"project:rename": Record<string, unknown>;
	"project:delete": Record<string, unknown>;
	"project:confirm-delete-response": Record<string, unknown>;
	"project:get-active": { project: ProjectInfo | null };
	"project:git-info": { info: GitRepoInfo | null };
	"project:git-diff": { files: GitDiffFile[] };
	"project:git-file-head": { content: string | null };
	"git:file-head": { content: string | null };

	// ── user profile / usage ──
	"user-profile:get": { profile: UserProfile | null };
	"user-profile:update": Record<string, unknown>;
	"user-profile:reset": Record<string, unknown>;
	"user-profile:logout": Record<string, unknown>;
	"usage:get": { usage: unknown };

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
	"workspace:stat": { node?: import("../types.js").FileTreeNode | null };
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
	"agent:list-subagents": { childSessionIds?: string[] };
	"agent:get-parent-session": { parentSessionId?: string | null };
	"agent:set-subagent-enabled": { enabled?: boolean };
	"agent:review-changes": { childSessionId: string | null; title: string };
	"agent-definitions:list": { agents?: AgentDefinitionInfo[] };
	"agent-definitions:create": { agent?: AgentDefinitionInfo };
	"agent-definitions:update": { agent?: AgentDefinitionInfo };
	"agent-definitions:delete": Record<string, unknown>;
	"agent-definitions:install": { agent?: AgentDefinitionInfo };
	"agent-definitions:set-enabled": Record<string, unknown>;

	// ── IM ──
	"im:get-channels": { channels?: ImChannelEntry[] };
	"im:connect-feishu": { registrationId?: string };
	"im:connect-feishu-manual": Record<string, unknown>;
	"im:cancel-registration": Record<string, unknown>;
	"im:disconnect-channel": Record<string, unknown>;
	"im:remove-channel": Record<string, unknown>;
	"im:reconnect-channel": Record<string, unknown>;
	"im:send-test-message": Record<string, unknown>;
	"im:test-connection": { message?: string };
	"im:test-connection-direct": { message?: string };
	"im:update-channel": Record<string, unknown>;
	"im:get-bindings": { bindings?: ImBindingEntry[] };
	"im:remove-binding": Record<string, unknown>;
	"im:get-bridge-status": { bindings: number; runningSessions: string[]; status: "running" | "stopped" };

	// ── MCP ──
	"mcp:list-servers": { servers: unknown[] };
	"mcp:add-server": Record<string, unknown>;
	"mcp:remove-server": Record<string, unknown>;
	"mcp:test-server": { tools?: McpToolEntry["tool"][] };
	"mcp:list-tools": { tools: unknown[] };
	"mcp:toggle-server": Record<string, unknown>;
	"mcp:list-all-tools": { tools?: McpToolEntry[] };
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

	// ── event-channel types（无 invoke handler，映射占位以穷尽联合） ──
	"app:ready": Record<string, unknown>;
	"window:traffic-light-center": Record<string, unknown>;
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
// 1. 键穷尽：映射键必须与 `RendererToMainEvent` 联合体完全一致——
//    新增 invoke 事件漏登记、或映射键拼写错误/残留，以下 `_AssertNever`
//    实例化即报错并指出具体键名。
// 2. LookAPI ↔ 映射 漂移：渲染端契约声明的方法成功载荷必须与
//    映射一致——`_AssertTrue` 在 `_Eq` 为 false 时报错。
//
// 每条断言独立一个 `type _Xn = …` 别名，报错时定位到具体断言。
// ============================================================

import type { RendererToMainEvent } from "../types/events/renderer-to-main.js";

/** 断言 T 恰为 never（用于穷尽性：多余/缺失键 → 非 never → 不满足约束 → 报错）。 */
type _AssertNever<T extends never> = T;
/** 断言 T 恰为 true（用于载荷相等性：不相等 → false → 不满足 `extends true` → 报错）。 */
type _AssertTrue<T extends true> = T;

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

type _X_Send = _AssertTrue<_Eq<_SuccessPayload<LookAPI["sendMessage"]>, InvokeResponseMap["agent:send-message"]>>;
type _X_Create = _AssertTrue<_Eq<_SuccessPayload<LookAPI["createAgent"]>, InvokeResponseMap["agent:create"]>>;
type _X_Models = _AssertTrue<_Eq<_SuccessPayload<LookAPI["getModels"]>, InvokeResponseMap["model:list"]>>;
type _X_Providers = _AssertTrue<_Eq<_SuccessPayload<LookAPI["getProviders"]>, InvokeResponseMap["model:providers"]>>;
type _X_Drafts = _AssertTrue<_Eq<_SuccessPayload<LookAPI["listDrafts"]>, InvokeResponseMap["draft:list"]>>;
type _X_Fork = _AssertTrue<_Eq<_SuccessPayload<LookAPI["createFork"]>, InvokeResponseMap["agent:create-fork"]>>;
type _X_Attachment = _AssertTrue<
	_Eq<_SuccessPayload<LookAPI["createAttachment"]>, InvokeResponseMap["attachment:create"]>
>;
type _X_ImChannels = _AssertTrue<_Eq<_SuccessPayload<LookAPI["getImChannels"]>, InvokeResponseMap["im:get-channels"]>>;
type _X_ImBindings = _AssertTrue<_Eq<_SuccessPayload<LookAPI["getImBindings"]>, InvokeResponseMap["im:get-bindings"]>>;
type _X_Review = _AssertTrue<_Eq<_SuccessPayload<LookAPI["reviewChanges"]>, InvokeResponseMap["agent:review-changes"]>>;
type _X_Navigate = _AssertTrue<_Eq<_SuccessPayload<LookAPI["navigateTree"]>, InvokeResponseMap["agent:navigate-tree"]>>;
type _X_History = _AssertTrue<
	_Eq<_SuccessPayload<LookAPI["loadHistoryPage"]>, InvokeResponseMap["session:history-page"]>
>;
type _X_ValidateCron = _AssertTrue<
	_Eq<_SuccessPayload<LookAPI["validateCron"]>, InvokeResponseMap["scheduled-task:validate-cron"]>
>;
type _X_FileWrite = _AssertTrue<_Eq<_SuccessPayload<LookAPI["writeFileContent"]>, InvokeResponseMap["file:write"]>>;
type _X_BrowserState = _AssertTrue<
	_Eq<_SuccessPayload<LookAPI["getBrowserPanelState"]>, InvokeResponseMap["browser:get-state"]>
>;

// 汇总导出：引用全部断言别名，确保它们参与类型计算（未引用的别名不会被求值）。
export type _InvokeResponseContractGuard = [
	_X_Missing,
	_X_Extra,
	_X_Send,
	_X_Create,
	_X_Models,
	_X_Providers,
	_X_Drafts,
	_X_Fork,
	_X_Attachment,
	_X_ImChannels,
	_X_ImBindings,
	_X_Review,
	_X_Navigate,
	_X_History,
	_X_ValidateCron,
	_X_FileWrite,
	_X_BrowserState,
];
