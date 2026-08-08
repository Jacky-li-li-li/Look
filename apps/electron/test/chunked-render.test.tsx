// @vitest-environment jsdom

class ResizeObserverMock {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { LookSessionEntry, SessionHistoryWindow, SessionSnapshotEnvelope } from "@look/shared/types";
import { act, cleanup, render } from "@testing-library/react";
import { Provider } from "jotai";
import { createRef } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatMessageList from "../src/renderer/components/chat/ChatMessageList";
import i18n from "../src/renderer/i18n";
import { appStore } from "../src/renderer/store/appStore";
import { sessionStateAtomFamily } from "../src/renderer/store/atoms";
import { emptyRendererSessionState, type RendererSessionState } from "../src/renderer/store/sessionTypes";
import { applySnapshot, prependHistoryPage, resetSnapshotSequences } from "../src/renderer/store/snapshot";

const assistantMessage = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "openai-responses",
	provider: "openai",
	model: "gpt-4o",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
});

function entry(id: string, role: "user" | "assistant"): LookSessionEntry {
	const message: UserMessage | AssistantMessage =
		role === "user"
			? { role, content: [{ type: "text", text: `user msg ${id}` }], timestamp: Date.now() }
			: assistantMessage(`assistant reply ${id}`);
	return { type: "message", id, message };
}

function makeEntries(count: number): LookSessionEntry[] {
	const entries: LookSessionEntry[] = [];
	for (let i = 0; i < count; i += 1) entries.push(entry(`entry-${i}`, i % 2 === 0 ? "user" : "assistant"));
	return entries;
}

function snapshot(
	sessionId: string,
	sequence: number,
	entries: LookSessionEntry[],
	reason: SessionSnapshotEnvelope["reason"] = "activate",
	partial = false,
	history?: SessionHistoryWindow,
): SessionSnapshotEnvelope {
	return {
		type: "session:snapshot",
		sessionId,
		reason,
		sequence,
		partial,
		history,
		leafId: entries.at(-1)?.id ?? null,
		entries,
		runtime: {
			thinkingLevel: "off",
			isStreaming: false,
			isRetrying: false,
			isCompacting: false,
			retryAttempt: 0,
			steering: [],
			followUp: [],
			stats: {
				totalMessages: entries.length,
				totalTurns: 0,
				totalTokens: 0,
			},
		},
	};
}

function listUi(state: RendererSessionState) {
	return (
		<I18nextProvider i18n={i18n}>
			<Provider store={appStore}>
				<ChatMessageList
					agentId="session-a"
					agentName="Session A"
					sessionState={state}
					autoCollapse
					phase="idle"
					isBusy={false}
					inputRef={createRef()}
					onSend={async () => true}
				/>
			</Provider>
		</I18nextProvider>
	);
}

function renderWithSnapshot(
	entries: LookSessionEntry[],
	sequence = 1,
	partial = false,
	history?: SessionHistoryWindow,
) {
	act(() => {
		applySnapshot(snapshot("session-a", sequence, entries, "activate", partial, history));
	});
	const state = appStore.get(sessionStateAtomFamily("session-a"));
	return render(listUi(state));
}

function countMessages(): number {
	return document.querySelectorAll("[data-message-id]").length;
}

describe("chunked cold render", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("en");
		vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"] });
		appStore.set(sessionStateAtomFamily("session-a"), emptyRendererSessionState());
		resetSnapshotSequences();
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("renders a large cold history tail first, then expands in small per-frame chunks", () => {
		renderWithSnapshot(makeEntries(60));

		const first = countMessages();
		expect(first).toBeGreaterThan(0);
		expect(first).toBeLessThan(60);
		expect(document.querySelector('[data-message-id="entry-59"]')).not.toBeNull();
		expect(document.querySelector('[data-message-id="entry-0"]')).toBeNull();

		for (let i = 0; i < 30 && countMessages() < 60; i += 1) {
			act(() => {
				vi.advanceTimersByTime(16);
			});
		}
		expect(countMessages()).toBe(60);
	});

	it("keeps the newest tail visible while a partial window grows into a complete snapshot", () => {
		const fullEntries = makeEntries(120);
		const partialEntries = fullEntries.slice(-40);
		const { rerender } = renderWithSnapshot(partialEntries, 2, true, {
			cursor: "entry-80",
			hasMore: true,
			revision: "entry-119",
		});
		const afterPartial = countMessages();
		expect(afterPartial).toBeGreaterThan(0);
		expect(afterPartial).toBeLessThan(40);
		expect(document.querySelector('[data-message-id="entry-119"]')).not.toBeNull();

		act(() => {
			applySnapshot(snapshot("session-a", 2, fullEntries, "activate", false));
		});
		rerender(listUi(appStore.get(sessionStateAtomFamily("session-a"))));
		expect(countMessages()).toBeLessThan(120);
		expect(document.querySelector('[data-message-id="entry-119"]')).not.toBeNull();

		for (let i = 0; i < 40 && countMessages() < 120; i += 1) {
			act(() => {
				vi.advanceTimersByTime(16);
			});
		}
		expect(countMessages()).toBe(120);
	});

	it("preserves the loaded tail while older pages are prepended", () => {
		const fullEntries = makeEntries(80);
		const tailEntries = fullEntries.slice(-40);
		const { rerender } = renderWithSnapshot(tailEntries, 4, true, {
			cursor: "entry-40",
			hasMore: true,
			revision: "entry-79",
		});

		for (let i = 0; i < 30 && countMessages() < 40; i += 1) {
			act(() => {
				vi.advanceTimersByTime(16);
			});
		}
		expect(countMessages()).toBe(40);

		act(() => {
			const accepted = prependHistoryPage(
				"session-a",
				{
					entries: fullEntries.slice(0, 40),
					leafId: "entry-79",
					history: { cursor: "entry-0", hasMore: false, revision: "entry-79" },
				},
				"entry-40",
			);
			expect(accepted).toBe(true);
		});
		rerender(listUi(appStore.get(sessionStateAtomFamily("session-a"))));
		expect(document.querySelector('[data-message-id="entry-79"]')).not.toBeNull();
		// The prepend must not reset the visible window back to a tiny newest-only
		// slice; the previously rendered tail remains the user's anchor.
		expect(countMessages()).toBeGreaterThanOrEqual(40);

		for (let i = 0; i < 30 && countMessages() < 80; i += 1) {
			act(() => {
				vi.advanceTimersByTime(16);
			});
		}
		expect(countMessages()).toBe(80);
	});

	it("renders small histories immediately without chunking", () => {
		renderWithSnapshot(makeEntries(5), 3);
		expect(countMessages()).toBe(5);
	});
});
