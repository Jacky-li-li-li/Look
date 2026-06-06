// ============================================================
// Shared types for Look
// Used by both main process and renderer
// ============================================================

/** Agent role template */
export type AgentRole =
	| "chat" // 通用聊天 agent
	| "orchestrator"
	| "coder"
	| "reviewer"
	| "crawler"
	| "cleaner"
	| "analyst"
	| "reporter"
	| "custom";

/** Agent status */
export type AgentStatus = "idle" | "thinking" | "working" | "error" | "destroyed";

/**
 * Per-agent permission mode. Controls how the permission gate
 * handles tool calls for this agent.
 *
 * - `ask` (default): every gate-flagged tool pops a dialog
 * - `plan`: only read-only tools (`read`/`grep`/`find`/`ls`) are
 *   allowed; everything else is blocked without asking
 * - `allow`: every tool is silently allowed (use only for trusted
 *   agents / scripted workflows)
 */
export type PermissionMode = "ask" | "plan" | "allow";

/**
 * User response to a permission ask. Mirrors the three buttons in
 * the PermissionDialog (Allow / Allow with edits / Deny). The
 * `edit` variant carries the patched args the main process should
 * apply to the tool's input before letting pi run it.
 */
export type PermissionDecision =
	| { action: "allow" }
	| { action: "deny"; reason: string }
	| { action: "edit"; args: Record<string, unknown> };

/** Pi thinking level — matches pi's built-in levels */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

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

/** Agent definition (config, not runtime) */
export interface AgentDefinition {
	id: string;
	name: string;
	role: AgentRole;
	model: string;
	thinkingLevel: ThinkingLevel;
	systemPrompt: string;
	tools: string[];
	isDefault: boolean;
}

/** Runtime agent info sent to renderer */
export interface AgentInfo {
	id: string;
	name: string;
	role: AgentRole;
	model: string;
	thinkingLevel: ThinkingLevel;
	status: AgentStatus;
	messageCount: number;
	createdAt: number;
	/** Cumulative token usage */
	usage: UsageSnapshot;
	/** Fallback model chain (provider/model-id) */
	fallbackModels: string[];
	/** Per-agent permission mode. Defaults to "ask". */
	permissionMode: PermissionMode;
	/** Path to the session JSONL file (~/.look/sessions/...). */
	sessionFilePath?: string;
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

/** One reasoning step within a merged multi-turn assistant reply */
export interface PiChunk {
	contentBlocks: PiContentBlock[];
}

// ============================================================
// Legacy types
// ============================================================

/** @deprecated Use PiChunk instead. */
export interface AssistantChunk {
	content: string;
	thinking?: string;
	toolCalls?: ToolCallRecord[];
}

/** A single message in an agent's conversation */
export interface AgentMessage {
	id: string;
	agentId: string;
	role: "user" | "assistant" | "tool" | "system";
	content: string;
	thinking?: string;
	toolCalls?: ToolCallRecord[];
	/** Multi-step chunks — when present, render as separate blocks under ONE agent label */
	assistantChunks?: AssistantChunk[];
	timestamp: number;
	isStreaming?: boolean;
	/** Token usage for this message (assistant messages only) */
	usage?: UsageSnapshot;
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
// Events (Main ↔ Renderer)
//
// `MainToRendererEvent` names mirror pi SDK AgentSessionEvent
// (see @earendil-works/pi-coding-agent/dist/core/agent-session.d.ts)
// with an `agent:` namespace prefix added by Look. Payloads use the
// SAME field names as pi's events so we can pass them through
// without translation. Look-specific events (list/created/destroyed/
// updated/permission:request/error/context-usage/compacting) are
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
	| WithAgentId<{ type: "agent:turn_end"; message: PiMessage; toolResults: unknown[] }>
	| WithAgentId<{ type: "agent:message_start"; message: PiMessage }>
	| WithAgentId<{
			type: "agent:message_update";
			message: PiMessage;
			assistantMessageEvent: AssistantMessageEventUnion;
	  }>
	| WithAgentId<{ type: "agent:message_end"; message: PiMessage }>
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
	| WithAgentId<{ type: "agent:list"; agents: AgentInfo[] }>
	| WithAgentId<{ type: "agent:created"; agent: AgentInfo }>
	| WithAgentId<{ type: "agent:destroyed" }>
	| WithAgentId<{ type: "agent:updated"; agent: AgentInfo }>
	// Emitted once after createAgent when the primary model was
	// unavailable and resolveModel picked a fallback. Lets the
	// renderer surface a "switched to X" toast (P-未5).
	| WithAgentId<{ type: "agent:model-fallback"; primary: string; resolved: string; triedChain: string[] }>
	| WithAgentId<{ type: "agent:status"; status: AgentStatus }>
	| WithAgentId<{ type: "agent:context-usage"; usage: ContextUsageInfo }>
	| WithAgentId<{ type: "agent:usage-update"; usage: UsageSnapshot }>
	| WithAgentId<{ type: "agent:history"; messages: PiMessage[] }>
	| WithAgentId<{ type: "agent:compacting"; compacting: boolean }>
	| {
			type: "permission:ask";
			requestId: string;
			agentId: string;
			toolName: string;
			args: Record<string, unknown>;
			reason: string;
	  }
	| WithAgentId<{ type: "agent:permission-mode"; mode: PermissionMode }>
	| { type: "error"; agentId?: string; message: string };

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
	| { type: "agent:send-message"; agentId: string; message: string; targetAgentId?: string }
	| {
			type: "agent:create";
			name: string;
			role: AgentRole;
			thinkingLevel?: ThinkingLevel;
			model?: string;
			parentAgentId?: string;
	  }
	| { type: "agent:destroy"; agentId: string }
	| { type: "agent:switch-model"; agentId: string; model: string }
	| { type: "agent:update-thinking"; agentId: string; level: ThinkingLevel }
	| { type: "agent:get-history"; agentId: string }
	| {
			type: "permission:response";
			action: "allow" | "deny" | "edit";
			requestId: string;
			reason?: string;
			args?: Record<string, unknown>;
	  }
	| { type: "permission:set-mode"; agentId: string; mode: PermissionMode }
	| { type: "model:list" }
	| { type: "model:providers" }
	| { type: "agents:list" }
	| { type: "settings:get" }
	| { type: "settings:get-api-key"; provider: string }
	| { type: "settings:set-api-key"; provider: string; key: string }
	| { type: "settings:test-api-key"; provider: string; key: string }
	| { type: "settings:test-env-key"; provider: string }
	| { type: "settings:get-verified-env" }
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
				defaultThinkingLevel: ThinkingLevel;
				autoCollapse: boolean;
				autoCompress: boolean;
				compressThreshold: number;
				preferredModel: string | null;
				chatSystemPrompt: string;
			}>;
	  }
	| { type: "settings:general:reset" }
	// ---- v0.3 skills IPC ----
	| { type: "skills:list" }
	| { type: "skills:invoke"; agentId: string; skillName: string; args?: string }
	| { type: "skills:import-paths"; paths: string[] }
	| { type: "skills:detect-common" }
	// ---- OS native dialogs (renderer → main) ----
	| { type: "dialog:open-directory" }
	| { type: "shell:reveal-in-finder"; path: string }
	// ---- OS shell: open project root in file manager ----
	| { type: "shell:open-project-folder" }
	| { type: "app:ready" };

// ============================================================
// Orchestrator — v0.2 / v0.3 types
//
// Full v0.2 (state machine, retry policy, leader decision, deps)
// lands in a separate change. This file declares the *minimal*
// TaskNode shape that downstream modules (currently: the skills
// loader) need. Fields are added incrementally.
// ============================================================

/**
 * Task node in the orchestrator's task graph.
 *
 * v0.2 fields (state, retry_policy, deps, branch_from_entry) are
 * TODO — see `docs/orchestrator-design.md` (not yet written).
 *
 * v0.3 fields (this commit):
 *   - allowedSkills: scope which skills a worker can see
 */
export interface TaskNode {
	/** Human-readable description of what this task should accomplish. */
	description?: string;

	// ── v0.3 skills scoping ───────────────────────────────────
	/**
	 * Restrict which skills the spawned worker can see.
	 * - `null` / `undefined` → all non-hidden skills visible
	 *   (subject to RoleConfig.defaultSkills if set)
	 * - `[]` → no skills (force pure LLM reasoning)
	 * - `["foo", "bar"]` → whitelist (intersected with the worker's
	 *   role defaultSkills)
	 *
	 * Skills with `disable-model-invocation: true` are always
	 * hidden from worker system prompts — they can only be
	 * invoked explicitly by the orchestrator via /skill:name.
	 */
	allowedSkills?: string[] | null;
}

// ============================================================
// Tool & Pipeline types
// ============================================================

export interface ToolSpec {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	roles: AgentRole[];
}

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
