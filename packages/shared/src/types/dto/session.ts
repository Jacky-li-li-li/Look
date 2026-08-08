import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ContextUsage, SessionStats } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../../types.js";

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
	/** Captured from CompactionResult.estimatedTokensAfter after manual compaction. */
	compactionEstimatedTokensAfter?: number;
}

export interface SessionHistoryWindow {
	/** The oldest entry currently present in the renderer window. */
	cursor: string | null;
	/** Whether entries exist before `cursor` on the current branch. */
	hasMore: boolean;
	/** Branch identity used to reject pages from a stale navigation. */
	revision: string;
}

export interface SessionHistoryPreviewEnvelope {
	type: "session:history-preview";
	sessionId: string;
	/** Shares the per-session sequence with normal snapshots. */
	sequence: number;
	leafId: string | null;
	entries: LookSessionEntry[];
	history: SessionHistoryWindow;
}

export interface SessionHistoryPage {
	/** Revision supplied by the renderer when this request was made. */
	requestRevision?: string;
	entries: LookSessionEntry[];
	leafId: string | null;
	history: SessionHistoryWindow;
}

export interface SessionSnapshotEnvelope {
	type: "session:snapshot";
	sessionId: string;
	reason: "initial" | "activate" | "agent_end" | "navigate" | "compaction_end";
	/**
	 * Monotonically increasing snapshot version per session. The renderer drops
	 * snapshots and previews whose sequence is older than the last applied one.
	 */
	sequence: number;
	/** When true, this snapshot carries only a history window, not the full branch. */
	partial?: boolean;
	/** Cursor metadata is present for partial snapshots and absent for complete ones. */
	history?: SessionHistoryWindow;
	leafId: string | null;
	/** Renderer-optimized entries. Translated from pi SDK SessionEntry[] in SessionNotifier. */
	entries: LookSessionEntry[];
	runtime: SessionRuntimeSnapshot;
}

// ============================================================
// LookSessionEntry — renderer-optimized subset of pi SDK SessionEntry
//
// The renderer only uses ~50% of pi SDK's SessionEntry fields. This type
// includes only what the renderer actually consumes, decoupling it from
// pi SDK internals. A translation function in SessionNotifier converts
// SDK entries before they cross the IPC boundary.
// ============================================================

export type LookSessionEntry =
	| { type: "message"; id: string; message: AgentMessage }
	| { type: "compaction"; id: string; summary: string; tokensBefore?: number }
	| { type: "branch_summary"; id: string; summary: string }
	| { type: "custom"; id: string; customType: string; data?: unknown }
	| { type: "custom_message"; id: string; customType: string; content: unknown; display: boolean }
	| { type: "model_change"; id: string; provider: string; modelId: string }
	| { type: "thinking_level_change"; id: string; thinkingLevel: string }
	| { type: "label"; id: string; label?: string }
	| { type: "session_info"; id: string; name?: string };

export interface ForkedSessionResult {
	/** New pi session ID created for the forked branch. */
	agentId: string;
	/** Path to the new .jsonl file the SDK created. */
	sessionFilePath: string;
}

export type NavigateTreeResult = Awaited<ReturnType<AgentSession["navigateTree"]>>;
