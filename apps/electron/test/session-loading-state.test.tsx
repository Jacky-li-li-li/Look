// @vitest-environment jsdom

class ResizeObserverMock {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { createRef } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatMessageList from "../src/renderer/components/chat/ChatMessageList";
import i18n from "../src/renderer/i18n";
import { appStore } from "../src/renderer/store/appStore";
import { sessionStateAtomFamily } from "../src/renderer/store/atoms";
import { emptyRendererSessionState, type RendererSessionPhase } from "../src/renderer/store/sessionTypes";
import { applySnapshot, markSessionSnapshotLoading } from "../src/renderer/store/snapshot";

function listUi(state = emptyRendererSessionState(), phase: RendererSessionPhase = "idle", isBusy = false) {
	return (
		<I18nextProvider i18n={i18n}>
			<Provider store={appStore}>
				<ChatMessageList
					agentId="session-a"
					agentName="Session A"
					sessionState={state}
					phase={phase}
					isBusy={isBusy}
					inputRef={createRef()}
					onSend={async () => true}
				/>
			</Provider>
		</I18nextProvider>
	);
}

function renderList(state = emptyRendererSessionState()) {
	return render(listUi(state));
}

describe("session snapshot loading state", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("en");
		appStore.set(sessionStateAtomFamily("session-a"), emptyRendererSessionState());
	});

	afterEach(() => cleanup());

	it("shows loading instead of the empty chat copy before the first snapshot arrives", () => {
		const state = { ...emptyRendererSessionState(), loadingSnapshot: true };
		renderList(state);
		expect(screen.getByText("Loading...")).toBeTruthy();
		expect(screen.queryByText(i18n.t("chat.greetingNoName"))).toBeNull();
	});

	it("shows the empty chat copy only after an empty snapshot has loaded", () => {
		const state = { ...emptyRendererSessionState(), snapshotLoaded: true, loadingSnapshot: false };
		renderList(state);
		expect(screen.getByText(i18n.t("chat.greetingNoName"))).toBeTruthy();
	});

	it("clears loading flags when a snapshot is applied", () => {
		markSessionSnapshotLoading("session-a", true);
		const entry: SessionEntry = {
			id: "entry-a",
			parentId: null,
			type: "message",
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "hello", timestamp: Date.now() },
		} as SessionEntry;
		applySnapshot({
			type: "session:snapshot",
			sessionId: "session-a",
			reason: "activate",
			leafId: "entry-a",
			entries: [entry],
			runtime: {
				model: undefined,
				thinkingLevel: "off",
				isStreaming: false,
				isRetrying: false,
				isCompacting: false,
				retryAttempt: 0,
				steering: [],
				followUp: [],
				stats: { totalMessages: 1 },
			},
		} as unknown as Parameters<typeof applySnapshot>[0]);
		const state = appStore.get(sessionStateAtomFamily("session-a"));
		expect(state.snapshotLoaded).toBe(true);
		expect(state.loadingSnapshot).toBe(false);
		expect(state.entries).toHaveLength(1);
	});

	it("renders persisted messages after a non-empty snapshot has loaded", () => {
		const userEntry: SessionEntry = {
			id: "entry-u1",
			parentId: null,
			type: "message",
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "hello agent", timestamp: Date.now() } as UserMessage,
		};
		const assistantEntry: SessionEntry = {
			id: "entry-a1",
			parentId: "entry-u1",
			type: "message",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hi, how can I help?" }],
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
			} as AssistantMessage,
		};
		const state = {
			...emptyRendererSessionState(),
			snapshotLoaded: true,
			loadingSnapshot: false,
			entries: [userEntry, assistantEntry],
			leafId: "entry-a1",
		};
		const { container } = renderList(state);

		expect(screen.queryByText("Loading...")).toBeNull();
		expect(screen.queryByText("No messages yet. Start a conversation.")).toBeNull();
		expect(screen.getByText("hello agent")).toBeTruthy();
		expect(screen.getByText("hi, how can I help?")).toBeTruthy();
		// 消息气泡容器应当可见（opacity-0 会移除元素的可视渲染）
		const bubbles = container.querySelectorAll(".whisper-bubble");
		expect(bubbles.length).toBeGreaterThanOrEqual(2);
	});

	it("keeps the assistant row geometry stable across the live-to-persisted handoff", async () => {
		const text = "stable handoff";
		const liveState = {
			...emptyRendererSessionState(),
			snapshotLoaded: true,
			uiPhase: "streaming" as const,
			uiBlocks: [
				{
					contentIndex: 0,
					kind: "text" as const,
					text,
					thinking: "",
					completed: false,
					uid: 1,
				},
			],
		};
		const view = render(listUi(liveState, "thinking", true));
		await waitFor(() => expect(view.container.textContent).toContain(text));

		const liveRow = view.container.querySelector('[data-message-id="streaming-live"]');
		const liveActions = liveRow?.querySelector("[data-message-actions]");
		expect(liveRow?.classList.contains("animate-draw-in")).toBe(false);
		expect(liveActions?.hasAttribute("data-reserved")).toBe(true);
		expect(liveActions?.classList.contains("min-h-6")).toBe(true);

		const assistantEntry: SessionEntry = {
			id: "entry-a1",
			parentId: null,
			type: "message",
			timestamp: new Date().toISOString(),
			message: {
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
			} as AssistantMessage,
		};
		const settledState = {
			...emptyRendererSessionState(),
			snapshotLoaded: true,
			entries: [assistantEntry],
			leafId: assistantEntry.id,
		};
		view.rerender(listUi(settledState));
		await waitFor(() => expect(view.container.querySelector('[data-message-id="entry-a1"]')).not.toBeNull());

		const settledRow = view.container.querySelector('[data-message-id="entry-a1"]');
		const settledActions = settledRow?.querySelector("[data-message-actions]");
		expect(settledRow?.classList.contains("animate-draw-in")).toBe(false);
		expect(settledActions?.hasAttribute("data-reserved")).toBe(false);
		expect(settledActions?.classList.contains("min-h-6")).toBe(true);
	});
});
