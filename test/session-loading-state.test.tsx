// @vitest-environment jsdom

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { cleanup, render, screen } from "@testing-library/react";
import { Provider } from "jotai";
import { createRef } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ChatMessageList from "../src/renderer/components/ChatMessageList";
import i18n from "../src/renderer/i18n";
import { sessionStateAtomFamily } from "../src/renderer/store/atoms";
import { appStore, applySnapshot, markSessionSnapshotLoading } from "../src/renderer/store/ipcHandler";
import { emptyRendererSessionState } from "../src/renderer/store/sessionTypes";

function renderList(state = emptyRendererSessionState()) {
	return render(
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
		</I18nextProvider>,
	);
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
		expect(screen.queryByText("No messages yet. Start a conversation.")).toBeNull();
	});

	it("shows the empty chat copy only after an empty snapshot has loaded", () => {
		const state = { ...emptyRendererSessionState(), snapshotLoaded: true, loadingSnapshot: false };
		renderList(state);
		expect(screen.getByText("No messages yet. Start a conversation.")).toBeTruthy();
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
		} as any);
		const state = appStore.get(sessionStateAtomFamily("session-a"));
		expect(state.snapshotLoaded).toBe(true);
		expect(state.loadingSnapshot).toBe(false);
		expect(state.entries).toHaveLength(1);
	});
});
