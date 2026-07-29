// ============================================================
// SubAgent Card Status — per-card status tracking atom
//
// Tracks per-toolCallId → per-taskTitle → status for subagent
// tool cards, so each card in a subagent_parallel/chain batch
// updates independently when its child session completes.
// ============================================================

import { atom } from "jotai";

export type SubagentCardStatus = "running" | "completed" | "failed" | "aborted";

/** Per-toolCallId → per-taskTitle → status. toolCallId is globally unique across all sessions. */
export const subagentCardStatusAtom = atom<Record<string, Record<string, SubagentCardStatus>>>({});
