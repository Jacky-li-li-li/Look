// ============================================================
// Shared types for Look
// Used by both main process and renderer
// ============================================================

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

/** Agent status */
export type SessionStatus = "idle" | "thinking" | "working" | "error" | "destroyed";

/** Pi thinking level — matches pi's built-in levels */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Permission mode — controls how tool calls are authorized */
export type PermissionMode = "always" | "ask" | "plan";

/** Permission ask event — sent from main to renderer when a tool needs approval */
export interface PermissionAskEvent {
	toolName: string;
	toolInput: Record<string, unknown>;
	toolDescription: string;
	requestId: string;
}

/** Permission response — sent from renderer to main with user decision */
export interface PermissionRespondPayload {
	requestId: string;
	action: "allow" | "deny" | "allow_always";
	editedInput?: Record<string, unknown>;
}

/** Token usage and cost snapshot */
export interface UsageSnapshot {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

/** Runtime agent info sent to renderer */
export interface AgentInfo {
	id: string;
	name: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	/** Whether the current model advertises reasoning support. */
	modelSupportsThinking?: boolean;
	/** Thinking levels supported by the current model (from pi SDK). */
	availableThinkingLevels?: ThinkingLevel[];
	status: SessionStatus;
	messageCount: number;
	createdAt: number;
	/** Cumulative token usage */
	usage: UsageSnapshot;
	/** Path to the session JSONL file (~/.look/sessions/...). */
	sessionFilePath?: string;
	/** Project this agent belongs to. undefined for legacy agents before migration. */
	projectId?: string;
}

// ============================================================
// Pi Content Block Types — directly map pi SDK content blocks
// ============================================================

/** pi SDK text block + streaming flag */
export interface PiTextBlock {
	type: "text";
	text: string;
	active?: boolean;
}

/** pi SDK thinking block + streaming flag */
export interface PiThinkingBlock {
	type: "thinking";
	thinking: string;
	redacted?: boolean;
	active?: boolean;
}

/** pi SDK toolCall block + runtime state injected by tool_execution events */
export interface PiToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	status: "pending" | "running" | "success" | "error";
	result?: string;
	isError?: boolean;
}

/** Union of all pi content block types with runtime extensions */
export type PiContentBlock = PiTextBlock | PiThinkingBlock | PiToolCallBlock;

/**
 * Replaces AgentMessage. Stores pi SDK content blocks directly.
 */
export interface PiMessage {
	id: string;
	agentId: string;
	role: "user" | "assistant" | "tool" | "system";
	contentBlocks: PiContentBlock[];
	timestamp: number;
	isStreaming?: boolean;
	usage?: UsageSnapshot;
	assistantChunks?: PiChunk[];
}

/** Raw pi AgentMessage transported only while a message is streaming. */
export interface PiStreamMessage {
	id: string;
	role: string;
	content: unknown;
	timestamp: number;
	usage?: unknown;
}

/** One reasoning step within a merged multi-turn assistant reply */
export interface PiChunk {
	contentBlocks: PiContentBlock[];
}

/** Record of a tool call */
export interface ToolCallRecord {
	callId: string;
	toolName: string;
	args: Record<string, unknown>;
	result?: string;
	isError?: boolean;
	status: "pending" | "running" | "success" | "error";
}

/** Context usage info for the ring indicator */
export interface ContextUsageInfo {
	percentage: number;
	usedTokens: number;
	totalTokens: number;
	level: "safe" | "warning" | "critical";
	compacting: boolean;
}

// ============================================================
// Session tree / branching (pi SDK tree structure, surfaced
// through Look). v0.4 — powers /tree (in-place navigate) and
// /fork (extract branch to a new .jsonl). See session-runtime-manager.ts
// for the methods that wrap pi's SessionManager + AgentSession.
// ============================================================

/**
 * Subset of a pi session entry that the renderer needs to draw
 * the tree. We deliberately do NOT ship the full entry payload
 * across IPC (tool arguments, full message text, etc.) — only
 * what's needed to render a node and decide what to do with it.
 *
 * `children` is recursively the same shape. Mirrors pi's
 * `SessionTreeNode` but flattened for IPC serialization.
 */
export interface SessionTreeNode {
	id: string;
	parentId: string | null;
	type:
		| "message"
		| "model_change"
		| "thinking_level_change"
		| "compaction"
		| "branch_summary"
		| "label"
		| "session_info"
		| "custom"
		| "custom_message";
	timestamp: string;
	/** For `type === "message"`: the role + a short text preview. */
	role?: "user" | "assistant" | "toolResult" | "bashExecution" | "custom" | "branchSummary" | "compactionSummary";
	textPreview?: string;
	/** For `type === "branch_summary"`: the LLM-generated summary text. */
	summary?: string;
	/** For `type === "label"`: the user-defined label string. */
	label?: string;
	children: SessionTreeNode[];
}

/** Lightweight shape returned by `getUserMessagesForForking`. */
export interface SessionForkPoint {
	entryId: string;
	/** Truncated to ~120 chars — full text is reconstructed by the renderer
	 *  from the session tree if needed. */
	text: string;
	timestamp: string;
}

/** Result of a `navigateTree` call. Mirrors `AgentSession.navigateTree`'s
 *  return shape, narrowed to the fields the renderer consumes. */
export interface NavigateTreeResult {
	/** The text of the user message we landed on, ready to be put in
	 *  the editor (so the user can edit-then-resubmit to create a new
	 *  branch). undefined when navigating to non-user entries. */
	editorText?: string;
	/** True if the user cancelled the summary prompt. */
	cancelled: boolean;
	/** True if the underlying call was aborted (e.g. user hit Stop). */
	aborted?: boolean;
}

/** Result of a `createForkedSession` call. */
export interface ForkedSessionResult {
	/** New pi session ID created for the forked branch. */
	agentId: string;
	/** Path to the new .jsonl file the SDK created. */
	sessionFilePath: string;
}

// ============================================================
// Events (Main ↔ Renderer)
//
// `MainToRendererEvent` names mirror pi SDK AgentSessionEvent
// (see @earendil-works/pi-coding-agent/dist/core/agent-session.d.ts)
// with an `agent:` namespace prefix added by Look. Payloads use the
// SAME field names as pi's events so we can pass them through
// without translation. Look-specific events (list/created/destroyed/
// updated/error/context-usage/compacting) are
// kept as-is — they have no pi equivalent.
// ============================================================

/**
 * Every event from main carries an `agentId` so the renderer can
 * correlate. Events not scoped to a single agent (rare — e.g.
 * `agent:list`) have an empty string.
 */
type WithAgentId<T> = T & { agentId: string };

/** Events sent from main process to renderer */
export type MainToRendererEvent =
	// ---- pi session events (mirrored, prefixed with `agent:`) ----
	| WithAgentId<{ type: "agent:agent_start" }>
	| WithAgentId<{ type: "agent:agent_end"; messages: PiMessage[]; willRetry: boolean }>
	| WithAgentId<{ type: "agent:turn_start" }>
	| WithAgentId<{ type: "agent:turn_end"; message: PiStreamMessage; toolResults: unknown[] }>
	| WithAgentId<{ type: "agent:message_start"; message: PiStreamMessage }>
	| WithAgentId<{
			type: "agent:message_update";
			message: PiStreamMessage;
			assistantMessageEvent: AssistantMessageEventUnion;
	  }>
	| WithAgentId<{ type: "agent:message_end"; message: PiStreamMessage }>
	| WithAgentId<{
			type: "agent:tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
	  }>
	| WithAgentId<{
			type: "agent:tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			partialResult: { content: Array<{ type: string; text?: string }>; details?: unknown };
	  }>
	| WithAgentId<{
			type: "agent:tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
	  }>
	| WithAgentId<{ type: "agent:queue_update"; steering: readonly string[]; followUp: readonly string[] }>
	| WithAgentId<{ type: "agent:compaction_start"; reason: "manual" | "threshold" | "overflow" }>
	| WithAgentId<{
			type: "agent:compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: unknown;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }>
	| WithAgentId<{
			type: "agent:auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }>
	| WithAgentId<{ type: "agent:auto_retry_end"; success: boolean; attempt: number; finalError?: string }>
	| WithAgentId<{ type: "agent:session_info_changed"; name: string | undefined }>
	| WithAgentId<{ type: "agent:thinking_level_changed"; level: ThinkingLevel }>
	// ---- Look-specific events (no pi equivalent) ----
	| { type: "agent:list"; projectId: string; agents: AgentInfo[] }
	| WithAgentId<{ type: "agent:created"; agent: AgentInfo }>
	| WithAgentId<{ type: "agent:destroyed" }>
	| WithAgentId<{ type: "agent:updated"; agent: AgentInfo }>
	| WithAgentId<{ type: "agent:status"; status: SessionStatus }>
	| WithAgentId<{ type: "agent:context-usage"; usage: ContextUsageInfo }>
	| WithAgentId<{ type: "agent:usage-update"; usage: UsageSnapshot }>
	| WithAgentId<{ type: "agent:history"; messages: PiMessage[] }>
	| WithAgentId<{ type: "agent:compacting"; compacting: boolean }>
	// v0.4 — tree / branching. Fired when the leaf or the tree shape
	// changed (navigate, label set, new branch created by forking).
	| WithAgentId<{
			type: "agent:tree-changed";
			leafId: string | null;
			tree: SessionTreeNode;
	  }>
	| { type: "error"; agentId?: string; message: string }
	// ---- Permission events ----
	| { type: "permission:ask"; agentId: string; event: PermissionAskEvent }
	// ---- Project events ----
	| { type: "project:list"; projects: ProjectInfo[]; activeProjectId: string | null }
	| { type: "project:active-changed"; projectId: string }
	| {
			type: "project:confirm-delete";
			projectId: string;
			projectName: string;
			agentCount: number;
			runningCount: number;
	  }
	// ---- Auto updater events ----
	| { type: "update:checking" }
	| { type: "update:available"; version: string; releaseDate?: string }
	| { type: "update:not-available" }
	| { type: "update:download-progress"; percent: number }
	| { type: "update:downloaded"; version: string }
	| { type: "update:error"; message: string };

/**
 * Subset of pi's AssistantMessageEvent delta types that Look
 * cares about. We don't import from `@earendil-works/pi-ai` here
 * because AgentSessionEvent already encodes the structure we need
 * and we want to keep `MainToRendererEvent` decoupled from pi's
 * internal type changes.
 */
export type AssistantMessageEventUnion =
	| { type: "text_start"; contentIndex: number; partial: unknown }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: unknown }
	| { type: "text_end"; contentIndex: number; content: string; partial: unknown }
	| { type: "thinking_start"; contentIndex: number; partial: unknown }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: unknown }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: unknown }
	| { type: "toolcall_start"; contentIndex: number; partial: unknown }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: unknown }
	| { type: "toolcall_end"; contentIndex: number; toolCall: unknown; partial: unknown }
	| { type: "start"; partial: unknown }
	| { type: "done"; reason: "stop" | "length" | "toolUse" | "error" | "aborted"; partial: unknown }
	| { type: "error"; reason: "aborted" | "error"; partial: unknown };

/** Events sent from renderer to main process */
export type RendererToMainEvent =
	| { type: "agent:send-message"; agentId: string; message: string }
	| { type: "agent:activate"; agentId: string }
	| { type: "agent:create"; name?: string; projectId?: string }
	| { type: "agent:destroy"; agentId: string }
	| { type: "agent:switch-model"; agentId: string; model: string }
	| { type: "agent:update-thinking"; agentId: string; level: ThinkingLevel }
	| { type: "agent:get-history"; agentId: string }
	| { type: "model:list" }
	| { type: "model:providers" }
	| { type: "agents:list" }
	| { type: "settings:get" }
	| { type: "settings:get-api-key"; provider: string }
	| { type: "settings:set-api-key"; provider: string; key: string }
	| { type: "settings:test-api-key"; provider: string; key: string }
	| { type: "settings:test-env-key"; provider: string }
	| { type: "settings:general:get" }
	| { type: "context:usage"; agentId: string }
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
			}>;
	  }
	| { type: "settings:general:reset" }
	// ---- v0.3 skills IPC ----
	| { type: "skills:list" }
	| { type: "skills:import-paths"; paths: string[] }
	| { type: "skills:detect-common" }
	// ---- OS native dialogs (renderer → main) ----
	| { type: "dialog:open-directory"; title?: string }
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
	| { type: "project:confirm-delete-response"; projectId: string; confirmed: boolean }
	| { type: "project:get-active" }
	// ---- v0.4 Session tree / branching ----
	/** Read the full session tree for an agent (for the tree-view UI). */
	| { type: "agent:get-session-tree"; agentId: string }
	/** List the user messages that can be selected as a fork point. */
	| { type: "agent:get-fork-points"; agentId: string }
	/**
	 * Navigate the session tree. This is the primary `/tree` operation:
	 *  - lands the leaf on `entryId`
	 *  - optionally summarizes the abandoned branch (LLM call)
	 *  - returns the user-message text (if any) to seed the editor
	 *  - emits `agent:tree-changed` and a fresh `agent:history` to the renderer
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
	/** Fork the active pi runtime to a new native session file. */
	| { type: "agent:create-fork"; agentId: string; entryId: string; name?: string }
	/** Set or clear a user-defined label on any entry. */
	| { type: "agent:set-entry-label"; agentId: string; entryId: string; label: string | null }
	// ---- Auto Updater ----
	| { type: "update:check" }
	| { type: "update:download" }
	| { type: "update:install" }
	// ---- User Profile ----
	| { type: "user-profile:get" }
	| {
			type: "user-profile:update";
			patch: Partial<{ userId: string; email: string; userName: string; avatar: string }>;
	  }
	| { type: "user-profile:reset" }
	// ---- MCP (Model Context Protocol) ----
	| { type: "mcp:list-servers" }
	| { type: "mcp:add-server"; name: string; config: Record<string, unknown> }
	| { type: "mcp:remove-server"; name: string }
	| { type: "mcp:restart-server"; name: string }
	| { type: "mcp:list-tools" }
	| { type: "mcp:connect-all" }
	// ---- Permission events (renderer → main) ----
	| { type: "permission:set-mode"; mode: PermissionMode }
	| { type: "permission:get-mode" }
	| { type: "permission:respond"; payload: PermissionRespondPayload };

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
