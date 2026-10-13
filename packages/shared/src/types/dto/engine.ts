// ============================================================
// Look-owned engine DTOs — structural copies of the subset of engine (pi SDK)
// shapes that cross the main↔renderer boundary.
//
// @look/shared must not import or re-export @earendil-works/pi-* types; the pi
// adapter (apps/electron/src/main/runtime-port/) converts engine values into
// these shapes. The fields mirror the current pi wire format 1:1, so IPC
// payloads are unchanged.
// ============================================================

/** Inline image content block (base64 payload). */
export interface LookImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

/** Plain text content block. */
export interface LookTextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

/** Model reasoning content block. */
export interface LookThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}

/** Assistant tool invocation content block. */
export interface LookToolCall {
	type: "toolCall";
	id: string;
	name: string;
	// biome-ignore lint/suspicious/noExplicitAny: mirrors engine tool-argument payloads.
	arguments: Record<string, any>;
	thoughtSignature?: string;
	namespace?: string;
}

/** Token / cost accounting attached to assistant messages. */
export interface LookUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type LookStopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export interface LookUserMessage {
	role: "user";
	content: string | (LookTextContent | LookImageContent)[];
	timestamp: number;
}

export interface LookAssistantMessage {
	role: "assistant";
	content: (LookTextContent | LookThinkingContent | LookToolCall)[];
	api: string;
	provider: string;
	model: string;
	responseModel?: string;
	responseId?: string;
	usage: LookUsage;
	stopReason: LookStopReason;
	errorMessage?: string;
	rawStopReason?: string;
	endTurn?: boolean;
	timestamp: number;
}

// biome-ignore lint/suspicious/noExplicitAny: mirrors engine tool-result details payloads.
export interface LookToolResultMessage<TDetails = any> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (LookTextContent | LookImageContent)[];
	details?: TDetails;
	usage?: LookUsage;
	addedToolNames?: string[];
	isError: boolean;
	timestamp: number;
}

export interface LookBashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	excludeFromContext?: boolean;
}

export interface LookCustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (LookTextContent | LookImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface LookBranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface LookCompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

/** Conversation message as persisted in a session entry / streamed to the renderer. */
export type LookAgentMessage =
	| LookUserMessage
	| LookAssistantMessage
	| LookToolResultMessage
	| LookBashExecutionMessage
	| LookCustomMessage
	| LookBranchSummaryMessage
	| LookCompactionSummaryMessage;

/** Context-window usage estimate. */
export interface LookContextUsage {
	/** Estimated context tokens, or null if unknown (e.g. right after compaction). */
	tokens: number | null;
	contextWindow: number;
	/** Usage as a percentage of the context window, or null if tokens is unknown. */
	percent: number | null;
}

/** Aggregated per-session statistics. */
export interface LookSessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: LookContextUsage;
}

/** Model identity / capabilities snapshot sent to the renderer. */
export interface LookModelInfo {
	id: string;
	name: string;
	api: string;
	provider: string;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
}

/** Where a skill / resource was discovered. */
export interface LookSourceInfo {
	path: string;
	source: string;
	scope: "user" | "project" | "temporary";
	origin: "package" | "top-level";
	baseDir?: string;
}

/** Branch summary entry created by a tree navigation with summarize=true. */
export interface LookBranchSummaryEntry {
	type: "branch_summary";
	id: string;
	parentId: string | null;
	timestamp: string;
	fromId: string;
	summary: string;
	details?: unknown;
	fromHook?: boolean;
}

/** Result of navigating the session tree. */
export interface NavigateTreeResult {
	editorText?: string;
	cancelled: boolean;
	aborted?: boolean;
	summaryEntry?: LookBranchSummaryEntry;
}
