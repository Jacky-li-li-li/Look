import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../../types.js";

/** Runtime agent info sent to renderer */
export interface AgentInfo {
	id: string;
	name: string;
	/** IM channel that created or owns this session, when applicable. */
	imProvider?: "feishu";
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
	/**
	 * 最近内容变更时间（文件落盘 mtime），用于侧栏排序。
	 * 仅在内容变化时更新——打开/查看/点击会话不刷新，避免列表因选中而跳位。
	 */
	lastActivityAt?: number;
	/** Path to the session JSONL file (~/.look/sessions/...). */
	sessionFilePath?: string;
	/** Immutable project binding for this runtime/session row. */
	projectId: string;
	// ---- SubAgent sub-session fields (Stage 1+) ----
	/** Parent session ID. When present this session is a subagent child session. */
	parentSessionId?: string;
	/** Whether this is a subagent child session. */
	isSubagentSession?: boolean;
	/** Agent definition name that triggered this sub-session (e.g. "scout"). */
	agentConfigName?: string;
	/** Current context usage (live-updating, used by ContextRing). */
	contextUsage?: ContextUsage;
}

/** Agent definition source. */
export type AgentDefinitionSource = "user" | "project" | "builtin";

/** Agent definition used by the renderer (aligned with extension-internal AgentConfig). */
export interface AgentDefinitionInfo {
	name: string;
	title?: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentDefinitionSource;
	filePath: string;
	/** Open Peeps avatar identifier, format `open-peeps:<id>` */
	icon?: string;
	tags?: string[];
	version?: string;
	author?: string;
	createdBy?: string;
	createdAt?: number;
	installedAt?: number;
}

/** Input for creating / updating an Agent definition (name is immutable, used as filename key). */
export interface AgentDefinitionInput {
	name: string;
	title?: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	/** Open Peeps avatar identifier, format `open-peeps:<id>` */
	icon?: string;
	tags?: string[];
	version?: string;
	author?: string;
	createdBy?: string;
	createdAt?: number;
	installedAt?: number;
}
