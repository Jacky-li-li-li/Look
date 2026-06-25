import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	AgentSessionEvent,
	ContextUsage,
	SessionEntry,
	SessionStats,
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
export type { AgentMessage, AgentSessionEvent, ImageContent, SessionEntry };

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
	editedInput?: Record<string, unknown>;
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
}

export interface SessionRuntimeSnapshot {
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

export interface SessionSdkEventEnvelope {
	type: "session:sdk-event";
	sessionId: string;
	event: AgentSessionEvent;
}

export type NavigateTreeResult = Awaited<ReturnType<AgentSession["navigateTree"]>>;

/** Result of a `createForkedSession` call. */
export interface ForkedSessionResult {
	/** New pi session ID created for the forked branch. */
	agentId: string;
	/** Path to the new .jsonl file the SDK created. */
	sessionFilePath: string;
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
	| SessionSdkEventEnvelope
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
	| { type: "plan:question-requested"; agentId: string; request: PlanQuestionRequest }
	| { type: "plan:question-resolved"; agentId: string; requestId: string }
	| { type: "plan:approval-requested"; agentId: string; request: PlanApprovalRequest }
	| { type: "plan:approval-resolved"; agentId: string; requestId: string }
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
	| { type: "update:error"; message: string };

/** Events sent from renderer to main process */
export type RendererToMainEvent =
	| { type: "agent:send-message"; agentId: string; message: string; images?: ImageContent[] }
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
				themeStyle: "ink-wash" | "swiss" | "bauhaus";
				themeTone: "light" | "dark";
			}>;
	  }
	| { type: "settings:general:reset" }
	// ---- v0.3 skills IPC ----
	| { type: "skills:list" }
	| { type: "skills:import-paths"; paths: string[] }
	| { type: "skills:detect-common" }
	// ---- OS native dialogs (renderer → main) ----
	| { type: "dialog:open-directory"; title?: string }
	| { type: "dialog:open-files"; title?: string; allowDirectories?: boolean; allowMultiple?: boolean }
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
	// ---- Shared area (renderer → main) ----
	| { type: "shared:list"; projectId: string }
	| { type: "shared:watch"; projectId: string }
	| { type: "shared:unwatch"; projectId: string }
	| { type: "shared:write"; projectId: string; path: string; content: string }
	| { type: "shared:mkdir"; projectId: string; path: string }
	| { type: "shared:delete"; projectId: string; path: string }
	| { type: "shared:import"; projectId: string; sources: string[]; targetDir?: string }
	| { type: "shared:export"; projectId: string; paths: string[]; destDir: string }
	/** Drag-drop fallback: write file content (base64) to the shared area. Used
	 *  when webUtils.getPathForFile() cannot return an absolute path. */
	| { type: "shared:write-content"; projectId: string; path: string; content: string; encoding: "base64" | "utf8" }
	// ---- Workspace tree (renderer → main) ----
	| { type: "workspace:list-children"; projectId: string; relativePath: string; showHiddenFiles?: boolean }
	| { type: "workspace:stat"; projectId: string; relativePath: string }
	| { type: "workspace:watch"; projectId: string; relativePath: string }
	| { type: "workspace:unwatch"; projectId: string; relativePath: string }
	// ---- Permission events (renderer → main) ----
	| { type: "permission:set-mode"; agentId: string; mode: PermissionMode }
	| { type: "permission:get-mode"; agentId: string }
	| { type: "permission:respond"; payload: PermissionRespondPayload }
	| { type: "plan:question-respond"; payload: PlanQuestionResponse }
	| { type: "plan:approval-respond"; payload: PlanApprovalResponse };

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
