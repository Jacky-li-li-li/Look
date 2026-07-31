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

export interface SessionSnapshotEnvelope {
	type: "session:snapshot";
	sessionId: string;
	reason: "initial" | "activate" | "agent_end" | "navigate" | "compaction_end";
	/**
	 * Monotonically increasing snapshot version per session. The main process
	 * bumps this on every emitSessionState; the renderer drops snapshots whose
	 * sequence is older than the last applied one. This prevents a deferred
	 * full-history snapshot (setImmediate) from clobbering streaming state
	 * produced by a newer turn.
	 */
	sequence: number;
	/** When true, this snapshot carries only a subset of the persisted history. */
	partial?: boolean;
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
