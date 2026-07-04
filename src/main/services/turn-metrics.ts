// ============================================================
// TurnMetricsService — persist per-turn duration to JSONL
//
// Extracted from SessionRuntimeManager. Pure function: takes a
// session and a turn start timestamp, computes the duration, and
// appends it to the session's JSONL as a custom entry.
// ============================================================

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { LOOK_MESSAGE_DURATION_ENTRY_TYPE, type LookMessageDurationEntryData } from "../shared/types.js";

/**
 * Compute and persist the duration of the most recent turn.
 * Should be called in `agent_end` handler.
 *
 * @param session - The live pi AgentSession.
 * @param turnStartedAt - Timestamp (ms) recorded at agent_start.
 */
export function persistTurnDuration(session: AgentSession, turnStartedAt: number): void {
	if (!session.sessionManager.isPersisted()) return;

	const durationMs = Date.now() - turnStartedAt;
	if (durationMs <= 0) return;

	const assistantEntry = [...session.sessionManager.getBranch()]
		.reverse()
		.find((entry) => entry.type === "message" && entry.message.role === "assistant");
	if (!assistantEntry) return;

	const data: LookMessageDurationEntryData = { entryId: assistantEntry.id, durationMs };
	session.sessionManager.appendCustomEntry(LOOK_MESSAGE_DURATION_ENTRY_TYPE, data);
}
