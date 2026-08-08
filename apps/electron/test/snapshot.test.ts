import type {
	LookSessionEntry,
	SessionHistoryPage,
	SessionHistoryPreviewEnvelope,
	SessionSnapshotEnvelope,
} from "@shared/types";
import { beforeEach, describe, expect, it } from "vitest";
import { appStore } from "../src/renderer/store/appStore";
import { sessionStateAtomFamily } from "../src/renderer/store/atoms";
import { emptyRendererSessionState } from "../src/renderer/store/sessionTypes";
import {
	applyHistoryPreview,
	applySnapshot,
	prependHistoryPage,
	resetSnapshotSequences,
} from "../src/renderer/store/snapshot";

function userEntry(id: string): LookSessionEntry {
	return { type: "message", id, message: { role: "user", content: `message ${id}` } } as LookSessionEntry;
}

function runtime(totalMessages: number) {
	return {
		thinkingLevel: "off" as const,
		isStreaming: false,
		isRetrying: false,
		isCompacting: false,
		retryAttempt: 0,
		steering: [],
		followUp: [],
		stats: { totalMessages, totalTurns: 0, totalTokens: 0 },
	};
}

function snapshot(
	entries: LookSessionEntry[],
	sequence: number,
	partial = false,
	history?: SessionSnapshotEnvelope["history"],
	reason: SessionSnapshotEnvelope["reason"] = "activate",
): SessionSnapshotEnvelope {
	return {
		type: "session:snapshot",
		sessionId: "session-a",
		reason,
		sequence,
		partial,
		history,
		leafId: entries.at(-1)?.id ?? null,
		entries,
		runtime: runtime(entries.length),
	};
}

describe("session history snapshot state", () => {
	beforeEach(() => {
		appStore.set(sessionStateAtomFamily("session-a"), emptyRendererSessionState());
		resetSnapshotSequences();
	});

	it("shows a tail preview without claiming that runtime/full history is ready", () => {
		const preview: SessionHistoryPreviewEnvelope = {
			type: "session:history-preview",
			sessionId: "session-a",
			sequence: 1,
			leafId: "m3",
			entries: [userEntry("m2"), userEntry("m3")],
			history: { cursor: "m2", hasMore: true, revision: "m3" },
		};

		applyHistoryPreview(preview);
		const state = appStore.get(sessionStateAtomFamily("session-a"));
		expect(state.historyStatus).toBe("partial");
		expect(state.historyCursor).toBe("m2");
		expect(state.snapshotLoaded).toBe(false);
		expect(state.entries.map((entry) => entry.id)).toEqual(["m2", "m3"]);
	});

	it("replaces a disk preview with the first runtime window instead of retaining physical-tail entries", () => {
		applyHistoryPreview({
			type: "session:history-preview",
			sessionId: "session-a",
			sequence: 1,
			leafId: "m3",
			entries: [userEntry("stale-branch"), userEntry("m2"), userEntry("m3")],
			history: { cursor: "stale-branch", hasMore: true, revision: "m3" },
		});
		applySnapshot(
			snapshot([userEntry("m2"), userEntry("m3")], 2, true, {
				cursor: "m2",
				hasMore: true,
				revision: "m3",
			}),
		);

		expect(appStore.get(sessionStateAtomFamily("session-a")).entries.map((entry) => entry.id)).toEqual(["m2", "m3"]);
	});

	it("marks a bounded preview complete when it already contains the whole branch", () => {
		applyHistoryPreview({
			type: "session:history-preview",
			sessionId: "session-a",
			sequence: 1,
			leafId: "m1",
			entries: [userEntry("m1")],
			history: { cursor: "m1", hasMore: false, revision: "m1" },
		});

		const state = appStore.get(sessionStateAtomFamily("session-a"));
		expect(state.historyStatus).toBe("complete");
		expect(state.historyCursor).toBeNull();
	});

	it("merges a partial tail and reuses unchanged entry references in the complete snapshot", () => {
		const oldTail = userEntry("m2");
		applySnapshot(
			snapshot([oldTail, userEntry("m3")], 1, true, {
				cursor: "m2",
				hasMore: true,
				revision: "m3",
			}),
		);
		const partialState = appStore.get(sessionStateAtomFamily("session-a"));
		const partialTail = partialState.entries[0];

		applySnapshot(snapshot([userEntry("m1"), userEntry("m2"), userEntry("m3")], 2));
		const completeState = appStore.get(sessionStateAtomFamily("session-a"));
		expect(completeState.historyStatus).toBe("complete");
		expect(completeState.entries.map((entry) => entry.id)).toEqual(["m1", "m2", "m3"]);
		expect(completeState.entries[1]).toBe(partialTail);
		expect(completeState.entries[1]).toBe(oldTail);
	});

	it("does not downgrade a completed page window when an equal-revision partial snapshot races in", () => {
		applySnapshot(
			snapshot([userEntry("m2"), userEntry("m3")], 1, true, {
				cursor: "m2",
				hasMore: true,
				revision: "m3",
			}),
		);
		prependHistoryPage(
			"session-a",
			{
				entries: [userEntry("m1")],
				leafId: "m3",
				history: { cursor: "m1", hasMore: false, revision: "m3" },
			},
			"m2",
		);
		applySnapshot(
			snapshot([userEntry("m2"), userEntry("m3")], 1, true, {
				cursor: "m2",
				hasMore: true,
				revision: "m3",
			}),
		);

		const state = appStore.get(sessionStateAtomFamily("session-a"));
		expect(state.historyStatus).toBe("complete");
		expect(state.entries.map((entry) => entry.id)).toEqual(["m1", "m2", "m3"]);
	});

	it("rejects an older page response after the cursor changed", () => {
		const entries = [userEntry("m2"), userEntry("m3")];
		applySnapshot(snapshot(entries, 1, true, { cursor: "m2", hasMore: true, revision: "m3" }));
		const stalePage: SessionHistoryPage = {
			entries: [userEntry("m1")],
			leafId: "m3",
			history: { cursor: null, hasMore: false, revision: "m3" },
		};

		expect(prependHistoryPage("session-a", stalePage, "wrong-cursor")).toBe(false);
		expect(appStore.get(sessionStateAtomFamily("session-a")).entries.map((entry) => entry.id)).toEqual(["m2", "m3"]);
	});

	it("prepends a valid page once and marks the branch complete at the root", () => {
		applySnapshot(
			snapshot([userEntry("m2"), userEntry("m3")], 1, true, {
				cursor: "m2",
				hasMore: true,
				revision: "m3",
			}),
		);
		const page: SessionHistoryPage = {
			entries: [userEntry("m1")],
			leafId: "m3",
			history: { cursor: "m1", hasMore: false, revision: "m3" },
		};

		expect(prependHistoryPage("session-a", page, "m2")).toBe(true);
		const state = appStore.get(sessionStateAtomFamily("session-a"));
		expect(state.historyStatus).toBe("complete");
		expect(state.entries.map((entry) => entry.id)).toEqual(["m1", "m2", "m3"]);
	});

	it("does not downgrade a completed page window when an equal-revision partial navigate snapshot races in", () => {
		applySnapshot(
			snapshot([userEntry("m2"), userEntry("m3")], 1, true, {
				cursor: "m2",
				hasMore: true,
				revision: "m3",
			}),
		);
		prependHistoryPage(
			"session-a",
			{
				entries: [userEntry("m1")],
				leafId: "m3",
				history: { cursor: "m1", hasMore: false, revision: "m3" },
			},
			"m2",
		);
		// A late partial navigate snapshot for the same revision must not throw
		// away the already-loaded complete window.
		applySnapshot(
			snapshot(
				[userEntry("m2"), userEntry("m3")],
				1,
				true,
				{
					cursor: "m2",
					hasMore: true,
					revision: "m3",
				},
				"navigate",
			),
		);

		const state = appStore.get(sessionStateAtomFamily("session-a"));
		expect(state.historyStatus).toBe("complete");
		expect(state.entries.map((entry) => entry.id)).toEqual(["m1", "m2", "m3"]);
	});

	it("preserves an already-complete history when an agent_end tail snapshot appends a new message", () => {
		applySnapshot(snapshot([userEntry("m1"), userEntry("m2"), userEntry("m3")], 1, false));
		expect(appStore.get(sessionStateAtomFamily("session-a")).historyStatus).toBe("complete");

		// agent_end emits only the latest tail entry; the loaded complete history
		// must be retained and the new tail merged in, without falling back to partial.
		const appendedSnapshot = snapshot(
			[userEntry("m4")],
			2,
			true,
			{
				cursor: "m4",
				hasMore: true,
				revision: "m4",
			},
			"agent_end",
		);
		applySnapshot(appendedSnapshot);

		const state = appStore.get(sessionStateAtomFamily("session-a"));
		expect(state.historyStatus).toBe("complete");
		expect(state.entries.map((entry) => entry.id)).toEqual(["m1", "m2", "m3", "m4"]);
	});
});
