// ============================================================
// Snapshot processor — applies main-process session snapshots and
// history windows to the renderer Jotai store.
// ============================================================

import {
	LOOK_MESSAGE_DURATION_ENTRY_TYPE,
	type LookMessageDurationEntryData,
	type LookSessionEntry,
	type SessionHistoryPage,
	type SessionHistoryPreviewEnvelope,
	type SessionHistoryWindow,
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
import type { RendererSessionState } from "./sessionTypes";

/**
 * Last-applied sequence is shared by previews, partial snapshots and complete
 * snapshots. A preview that arrives after a newer runtime snapshot must never
 * roll the renderer back to an older disk suffix.
 */
const lastAppliedSnapshotSequence = new Map<string, number>();

function sequenceOf(value: { sequence: number }): number {
	return typeof value.sequence === "number" && Number.isFinite(value.sequence) ? value.sequence : 0;
}

function acceptSequence(sessionId: string, sequence: number): boolean {
	const lastSequence = lastAppliedSnapshotSequence.get(sessionId) ?? 0;
	if (sequence < lastSequence) return false;
	lastAppliedSnapshotSequence.set(sessionId, sequence);
	return true;
}

function sameEntryShape(a: LookSessionEntry, b: LookSessionEntry): boolean {
	return a.id === b.id && a.type === b.type;
}

/** Persisted pi entries are append-only/immutable by ID. Reuse old objects when
 * a structured-cloned snapshot carries the same entry so memoized message rows
 * can bail out without comparing full Markdown payloads. */
function reuseEntries(
	previous: readonly LookSessionEntry[],
	incoming: readonly LookSessionEntry[],
): LookSessionEntry[] {
	if (previous.length === 0) return [...incoming];
	const previousById = new Map(previous.map((entry) => [entry.id, entry]));
	return incoming.map((entry) => {
		const old = previousById.get(entry.id);
		return old && sameEntryShape(old, entry) ? old : entry;
	});
}

function mergeTailEntries(
	previous: readonly LookSessionEntry[],
	incoming: readonly LookSessionEntry[],
	sameRevision: boolean,
): LookSessionEntry[] {
	if (!sameRevision || previous.length === 0) return [...incoming];
	const incomingIds = new Set(incoming.map((entry) => entry.id));
	const retained = previous.filter((entry) => !incomingIds.has(entry.id));
	return reuseEntries(previous, [...retained, ...incoming]);
}

function mergeAppendEntries(
	previous: readonly LookSessionEntry[],
	incoming: readonly LookSessionEntry[],
): LookSessionEntry[] {
	if (previous.length === 0) return [...incoming];
	const previousIndexById = new Map(previous.map((entry, index) => [entry.id, index]));
	const overlapIndex = incoming.reduce((lowest, entry) => {
		const index = previousIndexById.get(entry.id);
		return index == null ? lowest : Math.min(lowest, index);
	}, previous.length);
	const retained = previous.slice(0, overlapIndex).filter((entry) => !incoming.some((next) => next.id === entry.id));
	return reuseEntries(previous, [...retained, ...incoming]);
}

function collectDurations(
	previous: Record<string, number>,
	entries: readonly LookSessionEntry[],
): Record<string, number> {
	let next = previous;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== LOOK_MESSAGE_DURATION_ENTRY_TYPE) continue;
		const data = entry.data as LookMessageDurationEntryData | undefined;
		if (!data?.entryId || data.durationMs == null || data.durationMs <= 0) continue;
		if (next === previous) next = { ...previous };
		next[data.entryId] = data.durationMs;
	}
	return next;
}

function resolveLeafId(entries: readonly LookSessionEntry[], leafId: string | null): string | null {
	if (!leafId) return null;
	const leafEntry = entries.find((entry) => entry.id === leafId);
	if (leafEntry?.type === "custom" && leafEntry.customType === LOOK_MESSAGE_DURATION_ENTRY_TYPE) {
		const data = leafEntry.data as LookMessageDurationEntryData | undefined;
		if (data?.entryId) return data.entryId;
	}
	return leafId;
}

function fallbackHistory(entries: readonly LookSessionEntry[], leafId: string | null): SessionHistoryWindow {
	return {
		cursor: entries[0]?.id ?? null,
		hasMore: entries.length > 0,
		revision: leafId ?? entries.at(-1)?.id ?? "root",
	};
}

function applyAgentRuntimeProjection(snapshot: SessionSnapshotEnvelope): void {
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

function setLeafAndNavigationState(sessionId: string, leafId: string | null): void {
	appStore.set(sessionLeafIdAtomFamily(sessionId), leafId);
	appStore.set(navigatingEntryAtomFamily(sessionId), null);
	appStore.set(forkingEntryAtomFamily(sessionId), null);
}

export function markSessionSnapshotLoading(sessionId: string, loading: boolean): void {
	const atom = sessionStateAtomFamily(sessionId);
	const previous = appStore.get(atom);
	appStore.set(atom, {
		...previous,
		loadingSnapshot: loading && !previous.snapshotLoaded,
	});
}

export function applyHistoryPreview(preview: SessionHistoryPreviewEnvelope): void {
	const atom = sessionStateAtomFamily(preview.sessionId);
	const previous = appStore.get(atom);
	if (previous.historyStatus === "complete") return;
	if (!acceptSequence(preview.sessionId, sequenceOf(preview))) return;

	const sameRevision = previous.historyRevision === preview.history.revision;
	const hasMore = preview.history.hasMore;
	const entries = mergeTailEntries(previous.entries, preview.entries, sameRevision);
	const leafId = resolveLeafId(entries, preview.leafId);
	const next: RendererSessionState = {
		...previous,
		entries,
		leafId,
		historyStatus: hasMore ? "partial" : "complete",
		historyCursor: hasMore ? preview.history.cursor : null,
		historyRevision: preview.history.revision,
		messageDurations: collectDurations(previous.messageDurations, entries),
	};
	appStore.set(atom, next);
	setLeafAndNavigationState(preview.sessionId, leafId);
}

export function applySnapshot(snapshot: SessionSnapshotEnvelope): void {
	if (!acceptSequence(snapshot.sessionId, sequenceOf(snapshot))) return;

	const atom = sessionStateAtomFamily(snapshot.sessionId);
	const previous = appStore.get(atom);
	const isAgentEnd = snapshot.reason === "agent_end";
	const isPartial = snapshot.partial === true;
	const window = isPartial ? (snapshot.history ?? fallbackHistory(snapshot.entries, snapshot.leafId)) : undefined;
	const sameRevision = Boolean(window && previous.historyRevision === window.revision);
	const previewOnly = !previous.snapshotLoaded && previous.historyStatus === "partial";
	const isAppendSnapshot = isPartial && snapshot.reason === "agent_end";
	const canAppendPartial = isAppendSnapshot && previous.snapshotLoaded && !previewOnly;
	const canMergePartial = sameRevision && !previewOnly;
	const keepCompleteHistory = (canAppendPartial || canMergePartial) && previous.historyStatus === "complete";
	const entries = isPartial
		? canAppendPartial
			? mergeAppendEntries(previous.entries, snapshot.entries)
			: mergeTailEntries(previous.entries, snapshot.entries, canMergePartial)
		: reuseEntries(previous.entries, snapshot.entries);
	const hasMore = window?.hasMore === true;
	const leafId = resolveLeafId(entries, snapshot.leafId);
	const messageDurations = collectDurations(previous.messageDurations, entries);

	appStore.set(atom, {
		...previous,
		entries,
		leafId,
		historyStatus:
			keepCompleteHistory || (canAppendPartial && previous.historyStatus === "partial")
				? previous.historyStatus
				: isPartial && hasMore
					? "partial"
					: "complete",
		historyCursor: canAppendPartial
			? previous.historyStatus === "partial"
				? previous.historyCursor
				: null
			: keepCompleteHistory
				? null
				: isPartial && hasMore
					? (window?.cursor ?? null)
					: null,
		historyRevision: window?.revision ?? snapshot.leafId ?? entries.at(-1)?.id ?? "root",
		snapshotLoaded: true,
		loadingSnapshot: false,
		runtime: {
			...snapshot.runtime,
			steering: [...snapshot.runtime.steering],
			followUp: [...snapshot.runtime.followUp],
		},
		messageDurations,
		// Persisted history is authoritative after a terminal turn or branch
		// navigation. Keep live blocks during activation because a running session
		// may emit its persisted entry before the terminal UI event arrives.
		uiBlocks: isAgentEnd || snapshot.reason === "navigate" ? [] : previous.uiBlocks,
		uiTools: isAgentEnd || snapshot.reason === "navigate" ? {} : previous.uiTools,
		uiPhase: isAgentEnd || snapshot.reason === "navigate" ? "idle" : previous.uiPhase,
		uiSteering: [...snapshot.runtime.steering],
		uiFollowUp: [...snapshot.runtime.followUp],
		pendingUserMessage: null,
	});
	setLeafAndNavigationState(snapshot.sessionId, leafId);
	applyAgentRuntimeProjection(snapshot);
}

/**
 * Prepend a page only if it still belongs to the request that produced it.
 * Returns false for a stale cursor/revision so callers can silently discard a
 * response racing with activation or tree navigation.
 */
export function prependHistoryPage(
	sessionId: string,
	page: SessionHistoryPage,
	expectedCursor: string | null,
	expectedRevision?: string,
): boolean {
	const atom = sessionStateAtomFamily(sessionId);
	const previous = appStore.get(atom);
	if (previous.historyStatus !== "partial") return false;
	if (expectedRevision && previous.historyRevision !== expectedRevision) return false;
	if (page.requestRevision && expectedRevision && page.requestRevision !== expectedRevision) return false;
	if (previous.historyRevision !== page.history.revision) return false;
	if (previous.historyCursor !== expectedCursor) return false;

	const existingIds = new Set(previous.entries.map((entry) => entry.id));
	const newEntries = page.entries.filter((entry) => !existingIds.has(entry.id));
	const entries = reuseEntries(previous.entries, [...newEntries, ...previous.entries]);
	const leafId = resolveLeafId(entries, previous.leafId ?? page.leafId);
	appStore.set(atom, {
		...previous,
		entries,
		leafId,
		historyStatus: page.history.hasMore ? "partial" : "complete",
		historyCursor: page.history.cursor,
		historyRevision: page.history.revision,
		messageDurations: collectDurations(previous.messageDurations, page.entries),
	});
	appStore.set(sessionLeafIdAtomFamily(sessionId), leafId);
	return true;
}

/** Test isolation helper; production never needs to reset sequence state. */
export function resetSnapshotSequences(): void {
	lastAppliedSnapshotSequence.clear();
}
