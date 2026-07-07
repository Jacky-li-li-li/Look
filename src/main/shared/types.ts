import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	ContextUsage,
	ExtensionContext,
	SessionEntry,
	SessionStats,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

// Shared transport types. Message/session payloads remain SDK-native.

// ============================================================
// User Profile (shared between main & renderer)
// ============================================================

export interface UserProfile {
	userId: string;
	email: string;
	userName: string;
	avatar: string;
}

// ============================================================
// Project types (cwd-based project management)
// ============================================================

/** Project info — represents a workspace folder */
export interface ProjectInfo {
	id: string; // 8-char uuid
	name: string; // display name, derived from folder name
	cwd: string; // absolute path to project directory
	createdAt: number;
	valid: boolean; // whether cwd exists on disk (false if moved/deleted)
}

export type ThinkingLevel = ModelThinkingLevel;
export type { AgentMessage, ImageContent, SessionEntry };

export type ImSessionProvider = "feishu";

/** Permission mode — controls how tool calls are authorized */
export type PermissionMode = "always" | "ask" | "plan";

/** Permission ask event — sent from main to renderer when a tool needs approval */
export interface PermissionAskEvent {
	toolName: string;
	toolInput: Record<string, unknown>;
	toolDescription: string;
	requestId: string;
	expiresAt: number;
}

export interface PermissionAskQueueItem extends PermissionAskEvent {
	agentId: string;
}

/** Permission response — sent from renderer to main with user decision */
export interface PermissionRespondPayload {
	requestId: string;
	action: "allow" | "deny" | "allow_always";
}

// ── Types lifted from extensions (core contracts should not import from extensions) ──

/** pi SDK tool_call handler — returned by IPermissionService.createToolCallHandler. */
export type ToolCallHandler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult>;

/** Outcome of a plan-mode question dialogue. */
export interface PlanQuestionOutcome {
	status: "answered" | "cancelled";
	answers?: Record<string, string>;
	reason?: string;
}

/** Outcome of a plan-mode approval step. */
export interface PlanApprovalOutcome {
	status: "approved" | "rejected" | "cancelled";
	planId?: string;
	filePath?: string;
	reason?: string;
}

export interface PlanQuestionOption {
	label: string;
	description: string;
}

export interface PlanQuestion {
	question: string;
	header: string;
	options: PlanQuestionOption[];
	multiSelect?: boolean;
}

export interface PlanQuestionRequest {
	requestId: string;
	sessionId: string;
	questions: PlanQuestion[];
}

export interface PlanQuestionResponse {
	requestId: string;
	sessionId: string;
	answers: Record<string, string>;
}

export interface PlanApprovalRequest {
	requestId: string;
	planId: string;
	sessionId: string;
	plan: string;
	filePath: string;
}

export interface PlanApprovalResponse {
	requestId: string;
	sessionId: string;
	action: "approve" | "reject";
}

/** Runtime agent info sent to renderer */
export interface AgentInfo {
	id: string;
	name: string;
	/** IM channel that created or owns this session, when applicable. */
	imProvider?: ImSessionProvider;
	model: string;
	thinkingLevel: ThinkingLevel;
	/** Whether the current model advertises reasoning support. */
	modelSupportsThinking?: boolean;
	/** Thinking levels supported by the current model (from pi SDK). */
	availableThinkingLevels?: ThinkingLevel[];
	isStreaming: boolean;
	isRetrying: boolean;
	isCompacting: boolean;
	messageCount: number;
	createdAt: number;
	/** Path to the session JSONL file (~/.look/sessions/...). */
	sessionFilePath?: string;
	/** Immutable project binding for this runtime/session row. */
	projectId: string;
	// ---- SubAgent 子会话字段（Stage 1+） ----
	/** 父会话 ID。存在则表示本会话是 subagent 子会话，渲染层据此嵌套（Stage 4）。 */
	parentSessionId?: string;
	/** 是否为 subagent 子会话。 */
	isSubagentSession?: boolean;
	/** 触发本子会话的 Agent 定义名（如 "scout"）。 */
	agentConfigName?: string;
	/** 当前上下文使用量（实时更新，用于 ContextRing）。 */
	contextUsage?: import("@earendil-works/pi-coding-agent").ContextUsage;
}

export interface SessionRuntimeSnapshot {
	// biome-ignore lint/suspicious/noExplicitAny: Model generic parameter not relevant at shared type layer.
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isRetrying: boolean;
	isCompacting: boolean;
	retryAttempt: number;
	steering: readonly string[];
	followUp: readonly string[];
	stats: SessionStats;
	contextUsage?: ContextUsage;
}

export interface SessionSnapshotEnvelope {
	type: "session:snapshot";
	sessionId: string;
	reason: "initial" | "activate" | "agent_end" | "navigate";
	leafId: string | null;
	entries: SessionEntry[];
	runtime: SessionRuntimeSnapshot;
}

// ============================================================
// LookUiEvent — 离散 UI 事件翻译层
//
// 将 AgentSessionEvent 翻译为扁平、自包含的 UI 事件。
// 渲染进程只依赖此类型，不再 import @earendil-works/* SDK 类型。
//
// 核心设计：
//   1. assistantMessageEvent 的细粒度增量（text_delta/thinking_delta）
//      被翻译为离散的 delta 事件，渲染进程只需字符串拼接。
//   2. contentIndex 是消息内容块的稳定位置索引。
//   3. 所有事件自包含，无需合并或重建 SDK 对象。
// ============================================================

/** 渲染进程会话阶段 — 由 LookUiEvent 推导 */
export type LookUiPhase = "idle" | "streaming" | "working" | "retrying" | "compacting";

/** 离散的 UI 事件 — 扁平、自包含、无 SDK 类型依赖 */
export type LookUiEvent =
	// ── 文本流（assistant 消息 text 块） ──
	| { type: "assistant_text_start"; contentIndex: number; timestamp: number }
	| {
			type: "assistant_text_delta";
			contentIndex: number;
			delta: string;
			timestamp: number;
	  }
	| {
			type: "assistant_text_end";
			contentIndex: number;
			text: string;
			timestamp: number;
	  }

	// ── 思考流（assistant 消息 thinking 块） ──
	| { type: "thinking_start"; contentIndex: number; timestamp: number }
	| {
			type: "thinking_delta";
			contentIndex: number;
			delta: string;
			timestamp: number;
	  }
	| {
			type: "thinking_end";
			contentIndex: number;
			thinking: string;
			timestamp: number;
	  }

	// ── 工具调用流（assistant 决定调用工具） ──
	| {
			type: "toolcall_start";
			contentIndex: number;
			toolCallId: string;
			toolName: string;
			timestamp: number;
	  }
	| {
			type: "toolcall_arg_delta";
			contentIndex: number;
			delta: string;
			timestamp: number;
	  }
	| {
			type: "toolcall_end";
			contentIndex: number;
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			timestamp: number;
	  }

	// ── 工具执行（独立于消息流的系统运行） ──
	| {
			type: "tool_exec_start";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			timestamp: number;
	  }
	| {
			type: "tool_exec_update";
			toolCallId: string;
			partialResult: unknown;
			timestamp: number;
	  }
	| {
			type: "tool_exec_end";
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
			timestamp: number;
	  }

	// ── 运行状态 ──
	| {
			type: "run_status";
			status: LookUiPhase;
			willRetry?: boolean;
			timestamp: number;
	  }

	// ── 用户消息（由主进程在 message_start 时 emit） ──
	| {
			type: "user_message";
			text: string;
			images?: ImageContent[];
			timestamp: number;
	  }

	// ── 队列 ──
	| {
			type: "queue_update";
			steering: string[];
			followUp: string[];
			timestamp: number;
	  }

	// ── 压缩 ──
	| { type: "compacting"; active: boolean; timestamp: number }

	// ── 自动重试 ──
	| {
			type: "retry_status";
			status: "start" | "end";
			attempt?: number;
			maxAttempts?: number;
			delayMs?: number;
			errorMessage?: string;
			success?: boolean;
			finalError?: string;
			timestamp: number;
	  }

	// ── 会话元数据变更 ──
	| {
			type: "session_meta";
			field: "name" | "thinkingLevel";
			value: string;
			timestamp: number;
	  }

	// ── 错误 ──
	| { type: "error"; message: string; timestamp: number }

	// ── 消息生命周期标记（不含 SDK 消息体） ──
	| { type: "assistant_message_start"; timestamp: number }
	| { type: "assistant_message_end"; completed: boolean; timestamp: number };

/** IPC 封装：一批离散 UI 事件 */
export interface SessionUiEventEnvelope {
	type: "session:ui-event";
	sessionId: string;
	events: LookUiEvent[];
}

/** 渲染进程用流式块状态 — 由 LookUiEvent 增量更新 */
export interface LookUiStreamBlock {
	contentIndex: number;
	/** Monotonic UID unique per block within a session turn. Used as React key. */
	uid?: number;
	kind: "text" | "thinking" | "toolcall" | "image";
	text: string;
	thinking: string;
	toolCallId?: string;
	toolName?: string;
	args?: Record<string, unknown>;
	argsRaw?: string;
	/** Image content block (when kind === "image"). */
	image?: ImageContent;
	completed: boolean;
}

/** 渲染进程用工具执行状态 */
export interface LookUiToolExecState {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	phase: "running" | "completed";
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
}

export type NavigateTreeResult = Awaited<ReturnType<AgentSession["navigateTree"]>>;

/** Result of a `createForkedSession` call. */
export interface ForkedSessionResult {
	/** New pi session ID created for the forked branch. */
	agentId: string;
	/** Path to the new .jsonl file the SDK created. */
	sessionFilePath: string;
}

// ============================================================
// SubAgent — Agent 定义（渲染层友好的传输类型）
// ============================================================

/** Agent 定义来源 */
export type AgentDefinitionSource = "user" | "project" | "builtin";

/** 渲染层使用的 Agent 定义（与扩展内部 AgentConfig 对齐，去除系统提示等内部字段的可选项） */
export interface AgentDefinitionInfo {
	name: string;
	title?: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentDefinitionSource;
	filePath: string;
	icon?: string;
	tags?: string[];
	version?: string;
	author?: string;
	createdBy?: string;
	createdAt?: number;
	installedAt?: number;
}

/** 创建 / 更新 Agent 定义的输入（name 不可变，作为文件名标识） */
export interface AgentDefinitionInput {
	name: string;
	title?: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	icon?: string;
	tags?: string[];
	version?: string;
	author?: string;
	createdBy?: string;
	createdAt?: number;
	installedAt?: number;
}

export interface FileTreeNode {
	name: string;
	path: string;
	absolutePath: string;
	type: "file" | "directory";
	children?: FileTreeNode[];
	size?: number;
	modifiedAt?: number;
	extension?: string;
	isSymlink?: boolean;
	isHidden?: boolean;
}

type WithAgentId<T> = T & { agentId: string };

/** Events sent from main process to renderer */
export type MainToRendererEvent =
	| SessionUiEventEnvelope
	| SessionSnapshotEnvelope
	// ---- Look-specific events (no pi equivalent) ----
	| { type: "agent:list"; projectId: string; agents: AgentInfo[] }
	| WithAgentId<{ type: "agent:created"; agent: AgentInfo }>
	| WithAgentId<{ type: "agent:destroyed" }>
	| WithAgentId<{ type: "agent:updated"; agent: AgentInfo }>
	| { type: "error"; agentId?: string; message: string }
	// ---- Permission events ----
	| { type: "permission:ask"; agentId: string; event: PermissionAskEvent }
	| { type: "permission:resolved"; agentId: string; requestId: string }
	// ---- Plan interaction events ----
	| {
			type: "plan:question-requested";
			agentId: string;
			request: PlanQuestionRequest;
	  }
	| { type: "plan:question-resolved"; agentId: string; requestId: string }
	| {
			type: "plan:approval-requested";
			agentId: string;
			request: PlanApprovalRequest;
	  }
	| { type: "plan:approval-resolved"; agentId: string; requestId: string }
	// ---- SubAgent 事件 ----
	// Agent 定义变更通知（Stage 3 广场刷新）
	| { type: "subagent:definitions-updated" }
	// 进度 / 完成事件（父会话感知子会话，Stage 5）
	| {
			type: "session:subagent-progress";
			parentSessionId: string;
			childSessionId: string;
			agentName: string;
			task: string;
			status: "running" | "completed" | "failed" | "aborted";
			partialOutput: string;
			usage: {
				input: number;
				output: number;
				cacheRead: number;
				cacheWrite: number;
				cost: number;
				turns: number;
			};
			model?: string;
	  }
	| {
			type: "session:subagent-completed";
			parentSessionId: string;
			childSessionId: string;
			agentName: string;
			result: {
				sessionId: string;
				agentName: string;
				status: "completed" | "failed" | "aborted";
				finalOutput: string;
				model?: string;
				stopReason?: string;
				errorMessage?: string;
			};
	  }
	// ---- Project events ----
	| {
			type: "project:list";
			projects: ProjectInfo[];
			activeProjectId: string | null;
	  }
	| { type: "project:active-changed"; projectId: string }
	| {
			type: "project:confirm-delete";
			projectId: string;
			projectName: string;
			agentCount: number;
			runningCount: number;
	  }
	// ---- Shared area events ----
	| { type: "shared:updated"; projectId: string }
	// ---- Workspace tree events ----
	| { type: "workspace:updated"; projectId: string; relativePath: string }
	// ---- Auto updater events ----
	| { type: "update:checking" }
	| { type: "update:available"; version: string; releaseDate?: string }
	| { type: "update:not-available" }
	| { type: "update:download-progress"; percent: number }
	| { type: "update:downloaded"; version: string }
	| { type: "update:error"; message: string }
	// ---- IM / Feishu channel events ----
	| {
			type: "im:registration-update";
			registrationId: string;
			phase: "qr" | "polling" | "success" | "error";
			url?: string;
			expireIn?: number;
			error?: string;
			appId?: string;
	  }
	| {
			type: "im:channel-status";
			provider: string;
			status: "connected" | "disconnected" | "connecting" | "error";
			appId?: string;
			error?: string;
	  }
	| {
			type: "im:message-received";
			provider: string;
			messageId: string;
			chatId: string;
			senderId: string;
			senderName?: string;
			content: string;
			rawContentType: string;
			createTime: number;
			raw?: unknown;
	  }
	// ---- IM Bridge 状态事件 ----
	| {
			type: "im:bridge-status";
			bindings: number;
			runningSessions: string[];
			status: "running" | "stopped";
	  }
	// ---- TODO.md 任务进度 ----
	| {
			type: "todo:update";
			sessionId: string;
			items: TodoItem[];
	  }
	// ---- MCP server status changed ----
	| { type: "mcp:status-changed" }
	// ---- Usage data updated (after a turn completes) ----
	// ---- Context usage实时更新（流式输出期间轻量推送） ----
	| WithAgentId<{ type: "agent:context-usage"; contextUsage: ContextUsage }>
	| { type: "usage:updated" };

/** Custom provider model input (matches CustomProviderModelInput in custom-providers-store.ts) */
export interface CustomProviderModelInput {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	compat?: Record<string, unknown>;
}

/** Custom provider input (matches CustomProviderInput in custom-providers-store.ts) */
export interface CustomProviderInput {
	name: string;
	baseUrl: string;
	api: "openai-completions" | "anthropic-messages" | "google-generative-ai" | "openai-responses";
	apiKey?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	models: CustomProviderModelInput[];
	compat?: Record<string, unknown>;
}

/** Per-model self-test result */
export interface ModelTestResult {
	modelId: string;
	ok: boolean;
	error?: string;
	latencyMs?: number;
}

/** Overall result of testing a custom provider's models */
export interface TestCustomProviderResult {
	overall: "ok" | "fail";
	results: ModelTestResult[];
}

/** Events sent from renderer to main process */
export type RendererToMainEvent =
	| {
			type: "agent:send-message";
			agentId: string;
			message: string;
			images?: ImageContent[];
	  }
	| { type: "agent:activate"; agentId: string }
	| { type: "agent:create"; name?: string; projectId?: string }
	| { type: "agent:destroy"; agentId: string }
	| { type: "agent:switch-model"; agentId: string; model: string }
	| { type: "agent:update-thinking"; agentId: string; level: ThinkingLevel }
	| { type: "model:list" }
	| { type: "model:providers" }
	| { type: "agents:list" }
	| { type: "settings:get" }
	| { type: "settings:get-api-key"; provider: string }
	| { type: "settings:set-api-key"; provider: string; key: string }
	| { type: "settings:test-api-key"; provider: string; key: string }
	| { type: "settings:test-env-key"; provider: string }
	| { type: "settings:general:get" }
	// ---- Custom provider IPC ----
	| { type: "settings:add-custom-provider"; payload: CustomProviderInput }
	| {
			type: "settings:update-custom-provider";
			payload: { name: string; patch: Partial<CustomProviderInput> };
	  }
	| { type: "settings:remove-custom-provider"; payload: { name: string } }
	| { type: "settings:list-custom-providers" }
	| { type: "settings:test-custom-provider"; payload: CustomProviderInput }
	| { type: "session:compress"; agentId: string }
	| { type: "agent:rename"; agentId: string; name: string }
	// P2-2: renderer → main "stop the current turn" signal. Matches
	// the new agent:abort case in ipc-handlers.ts.
	| { type: "agent:abort"; agentId: string }
	| {
			type: "settings:general:set";
			settings: Partial<{
				language: "en" | "zh" | "ja";
				autoCollapse: boolean;
				compactionEnabled: boolean;
				permissionMode: PermissionMode;
				preferredModel: string | null;
				lastActiveSessionId: string;
				lastActiveProjectId: string;
				openProjectIds: string[];
				openedSessionIds: string[];
				themeStyle: "ink-wash" | "swiss" | "bauhaus";
				themeTone: "light" | "dark";
				subagentEnabled: boolean;
				enabledAgentDefinitions: string[] | null;
				enabledSkills: string[] | null;
			}>;
	  }
	| { type: "settings:general:reset" }
	// ---- v0.3 skills IPC ----
	| { type: "skills:list" }
	| { type: "skills:import-paths"; paths: string[] }
	| { type: "skills:detect-common" }
	// ---- OS native dialogs (renderer → main) ----
	| { type: "dialog:open-directory"; title?: string }
	| {
			type: "dialog:open-files";
			title?: string;
			allowDirectories?: boolean;
			allowMultiple?: boolean;
	  }
	| { type: "shell:reveal-in-finder"; path: string }
	// ---- OS shell: open project root in file manager ----
	| { type: "shell:open-project-folder"; projectId?: string }
	| { type: "app:ready" }
	// ---- Project CRUD ----
	| { type: "project:list" }
	| { type: "project:create"; cwd: string; name?: string }
	| { type: "project:switch"; projectId: string }
	| { type: "project:rename"; projectId: string; name: string }
	| { type: "project:delete"; projectId: string }
	| {
			type: "project:confirm-delete-response";
			projectId: string;
			confirmed: boolean;
	  }
	| { type: "project:get-active" }
	// ---- v0.4 Session tree / branching ----
	/**
	 * Navigate the session tree. This is the primary `/tree` operation:
	 *  - lands the leaf on `entryId`
	 *  - optionally summarizes the abandoned branch (LLM call)
	 *  - returns the user-message text (if any) to seed the editor
	 *  - emits a fresh native `session:snapshot` to the renderer
	 */
	| {
			type: "agent:navigate-tree";
			agentId: string;
			entryId: string;
			/** Generate a branch summary for the abandoned path. */
			summarize?: boolean;
			/** Override the default summary prompt. */
			customInstructions?: string;
			/** User-defined label to attach to the summary entry. */
			label?: string;
	  }
	/** Create a parallel pi runtime from this session without replacing the source runtime. */
	| {
			type: "agent:create-fork";
			agentId: string;
			entryId: string;
			name?: string;
	  }
	/** Set or clear a user-defined label on any entry. */
	| {
			type: "agent:set-entry-label";
			agentId: string;
			entryId: string;
			label: string | null;
	  }
	// ---- Auto Updater ----
	| { type: "update:check" }
	| { type: "update:download" }
	| { type: "update:install" }
	// ---- User Profile ----
	| { type: "user-profile:get" }
	| {
			type: "user-profile:update";
			patch: Partial<{
				userId: string;
				email: string;
				userName: string;
				avatar: string;
			}>;
	  }
	| { type: "user-profile:reset" }
	// ---- Usage heatmap (renderer → main) ----
	| { type: "usage:get" }
	// ---- Shared area (renderer → main) ----
	| { type: "shared:list"; projectId: string }
	| { type: "shared:watch"; projectId: string }
	| { type: "shared:unwatch"; projectId: string }
	| { type: "shared:write"; projectId: string; path: string; content: string }
	| { type: "shared:mkdir"; projectId: string; path: string }
	| { type: "shared:delete"; projectId: string; path: string }
	| {
			type: "shared:import";
			projectId: string;
			sources: string[];
			targetDir?: string;
	  }
	| {
			type: "shared:export";
			projectId: string;
			paths: string[];
			destDir: string;
	  }
	/** Drag-drop fallback: write file content (base64) to the shared area. Used
	 *  when webUtils.getPathForFile() cannot return an absolute path. */
	| {
			type: "shared:write-content";
			projectId: string;
			path: string;
			content: string;
			encoding: "base64" | "utf8";
	  }
	// ---- Workspace tree (renderer → main) ----
	| {
			type: "workspace:list-children";
			projectId: string;
			relativePath: string;
			showHiddenFiles?: boolean;
	  }
	| { type: "workspace:stat"; projectId: string; relativePath: string }
	| { type: "workspace:watch"; projectId: string; relativePath: string }
	| { type: "workspace:unwatch"; projectId: string; relativePath: string }
	// ---- Permission events (renderer → main) ----
	| { type: "permission:set-mode"; agentId: string; mode: PermissionMode }
	| { type: "permission:get-mode"; agentId: string }
	| { type: "permission:respond"; payload: PermissionRespondPayload }
	| { type: "plan:question-respond"; payload: PlanQuestionResponse }
	| { type: "plan:approval-respond"; payload: PlanApprovalResponse }
	// ---- SubAgent：子会话关系查询（Stage 4 嵌套） ----
	| { type: "agent:list-subagents"; parentSessionId: string }
	| { type: "agent:get-parent-session"; childSessionId: string }
	// ---- SubAgent：Agent 开关（Stage 2，应用到所有活动会话 + 持久化为默认） ----
	| { type: "agent:set-subagent-enabled"; enabled: boolean }
	// ---- SubAgent：Agent 定义 CRUD（Stage 3 广场） ----
	| { type: "agent-definitions:list" }
	| { type: "agent-definitions:create"; input: AgentDefinitionInput }
	| {
			type: "agent-definitions:update";
			name: string;
			input: AgentDefinitionInput;
	  }
	| { type: "agent-definitions:delete"; name: string }
	| { type: "agent-definitions:install"; name: string; source: "builtin" }
	// ---- SubAgent：Agent 定义开关 ----
	| { type: "agent-definitions:set-enabled"; name: string; enabled: boolean }
	// ---- Skills：Skill 开关 ----
	| { type: "skills:set-enabled"; name: string; enabled: boolean }
	// ---- IM / Feishu channel management ----
	| { type: "im:get-channels" }
	| { type: "im:connect-feishu"; appName?: string; description?: string }
	| {
			type: "im:connect-feishu-manual";
			appId: string;
			appSecret: string;
			name?: string;
	  }
	| { type: "im:cancel-registration"; registrationId: string }
	| { type: "im:disconnect-channel"; provider: string; appId?: string }
	| { type: "im:remove-channel"; provider: string; appId: string }
	| { type: "im:reconnect-channel"; provider: string; appId: string }
	| {
			type: "im:send-test-message";
			receiveIdType: string;
			receiveId: string;
			text: string;
	  }
	| { type: "im:test-connection"; appId: string }
	| {
			type: "im:test-connection-direct";
			appId: string;
			appSecret: string;
			name?: string;
	  }
	| { type: "im:update-channel"; appId: string; name?: string }
	// ---- IM Bridge ----
	| { type: "im:get-bindings" }
	| { type: "im:remove-binding"; chatId: string }
	| { type: "im:get-bridge-status" }
	// ---- Custom System Prompts ----
	| { type: "settings:prompts:list" }
	| { type: "settings:prompts:create"; name: string; content: string }
	| {
			type: "settings:prompts:update";
			id: string;
			name?: string;
			content?: string;
	  }
	| { type: "settings:prompts:delete"; id: string }
	| { type: "settings:prompts:set-active"; id: string }
	// ---- Project-level Prompts ----
	| { type: "settings:project-prompts:list"; projectId: string }
	| {
			type: "settings:project-prompts:create";
			projectId: string;
			name: string;
			content: string;
	  }
	| {
			type: "settings:project-prompts:update";
			projectId: string;
			id: string;
			name?: string;
			content?: string;
	  }
	| { type: "settings:project-prompts:delete"; projectId: string; id: string }
	| {
			type: "settings:project-prompts:set-active";
			projectId: string;
			id: string;
	  }
	// ---- MCP server management ----
	| { type: "mcp:list-servers" }
	| { type: "mcp:add-server"; config: Record<string, unknown> }
	| { type: "mcp:remove-server"; name: string }
	| { type: "mcp:test-server"; name: string }
	| { type: "mcp:list-tools"; name: string }
	| { type: "mcp:toggle-server"; name: string; enabled: boolean }
	| { type: "mcp:list-all-tools" }
	| {
			type: "mcp:update-server";
			name: string;
			config: Record<string, unknown>;
	  };

/** Available model info (returned from ModelRegistry) */
export interface AvailableModel {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number };
}

/** Provider info */
export interface ProviderInfo {
	id: string;
	name: string;
	hasCredentials: boolean;
	models: string[];
}

// ============================================================
// Usage heatmap persistence
// ============================================================

export interface UsageData {
	usage: Record<string, number>;
	modelCost: Record<string, Record<string, { turns: number; cost: number }>>;
	years: number[];
}

// ============================================================
// Per-message turn duration persistence
// ============================================================

export const LOOK_MESSAGE_DURATION_ENTRY_TYPE = "look.message-duration.v1";

export interface LookMessageDurationEntryData {
	entryId: string;
	durationMs: number;
}

// ============================================================
// TODO.md 实时可视化
// ============================================================

export interface TodoItem {
	text: string; // 任务文本（去掉 "- [ ]" 前缀）
	done: boolean; // 是否完成
	line: number; // TODO.md 原始行号
}

/** Event listener callback. */
export type EventCallback = (event: MainToRendererEvent) => void;
