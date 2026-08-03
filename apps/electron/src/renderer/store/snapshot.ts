// ============================================================
// Snapshot processor — applies main-process session snapshots
// to the renderer Jotai store.
// ============================================================

import {
	LOOK_MESSAGE_DURATION_ENTRY_TYPE,
	type LookMessageDurationEntryData,
	type SessionSnapshotEnvelope,
} from "@shared/types";
import { appStore } from "./appStore";
import {
	agentsAtom,
	forkingEntryAtomFamily,
	navigatingEntryAtomFamily,
	sessionLeafIdAtomFamily,
	sessionStateAtomFamily,
} from "./atoms";

/**
 * Last-applied snapshot sequence per session. Snapshots are versioned by the
 * main process (SessionNotifier.sequence); the deferred full-history snapshot
 * that follows a partial one must not clobber streaming state produced by a
 * newer turn, so any snapshot whose sequence is older than the last applied
 * one is dropped.
 *
 * NOTE: comparison is strict `<` (equal sequence IS applied). SessionNotifier
 * emits the partial and the deferred full snapshot with the SAME sequence —
 * the equal-sequence full snapshot must replace the partial, not be dropped.
 */
const lastAppliedSnapshotSequence = new Map<string, number>();

export function markSessionSnapshotLoading(sessionId: string, loading: boolean): void {
	const atom = sessionStateAtomFamily(sessionId);
	const previous = appStore.get(atom);
	appStore.set(atom, {
		...previous,
		loadingSnapshot: loading && !previous.snapshotLoaded,
	});
}

export function applySnapshot(snapshot: SessionSnapshotEnvelope): void {
	const lastSequence = lastAppliedSnapshotSequence.get(snapshot.sessionId) ?? 0;
	if (snapshot.sequence < lastSequence) return;
	lastAppliedSnapshotSequence.set(snapshot.sessionId, snapshot.sequence);

	const previous = appStore.get(sessionStateAtomFamily(snapshot.sessionId));
	const isAgentEnd = snapshot.reason === "agent_end";

	// Load per-message durations persisted as custom entries by the main process.
	const messageDurations = { ...previous.messageDurations };
	for (const entry of snapshot.entries) {
		if (entry.type === "custom" && entry.customType === LOOK_MESSAGE_DURATION_ENTRY_TYPE) {
			const data = entry.data as LookMessageDurationEntryData | undefined;
			if (data?.entryId && data.durationMs != null && data.durationMs > 0) {
				messageDurations[data.entryId] = data.durationMs;
			}
		}
	}

	// The main process appends a duration custom entry as the leaf after a turn.
	// Treat the assistant message it belongs to as the active leaf for the UI.
	let leafId = snapshot.leafId;
	if (leafId) {
		const leafEntry = snapshot.entries.find((entry) => entry.id === leafId);
		if (leafEntry?.type === "custom" && leafEntry.customType === LOOK_MESSAGE_DURATION_ENTRY_TYPE) {
			const data = leafEntry.data as LookMessageDurationEntryData | undefined;
			if (data?.entryId) leafId = data.entryId;
		}
	}

	appStore.set(sessionStateAtomFamily(snapshot.sessionId), {
		...previous,
		entries: snapshot.entries,
		leafId,
		snapshotLoaded: true,
		loadingSnapshot: false,
		runtime: {
			...snapshot.runtime,
			steering: [...snapshot.runtime.steering],
			followUp: [...snapshot.runtime.followUp],
		},
		messageDurations,
		// Snapshots are the source of truth for persisted history. Clear streaming
		// state when the agent has ended (turn completed, entries are truth) or
		// when navigating to a different branch (old streaming blocks are stale).
		// Do NOT clear for "activate"/"initial" snapshots — the session may still
		// be actively streaming, and uiBlocks carry live content that should be
		// preserved until the terminal stream event signals completion.
		uiBlocks: isAgentEnd || snapshot.reason === "navigate" ? [] : previous.uiBlocks,
		uiTools: isAgentEnd || snapshot.reason === "navigate" ? {} : previous.uiTools,
		uiPhase: isAgentEnd || snapshot.reason === "navigate" ? "idle" : previous.uiPhase,
		uiSteering: isAgentEnd || snapshot.reason === "navigate" ? [] : previous.uiSteering,
		uiFollowUp: isAgentEnd || snapshot.reason === "navigate" ? [] : previous.uiFollowUp,
		// Always clear the pending user message after a snapshot — the snapshot
		// entries are now the source of truth for message history.
		pendingUserMessage: null,
	});
	appStore.set(sessionLeafIdAtomFamily(snapshot.sessionId), leafId);
	appStore.set(navigatingEntryAtomFamily(snapshot.sessionId), null);
	appStore.set(forkingEntryAtomFamily(snapshot.sessionId), null);
	appStore.set(
		agentsAtom,
		appStore.get(agentsAtom).map((agent) =>
			agent.id === snapshot.sessionId
				? {
						...agent,
						model: snapshot.runtime.model
							? `${snapshot.runtime.model.provider}/${snapshot.runtime.model.id}`
							: agent.model,
						thinkingLevel: snapshot.runtime.thinkingLevel,
						isStreaming: snapshot.runtime.isStreaming,
						isRetrying: snapshot.runtime.isRetrying,
						isCompacting: snapshot.runtime.isCompacting,
						messageCount: snapshot.runtime.stats.totalMessages,
					}
				: agent,
		),
	);
}
