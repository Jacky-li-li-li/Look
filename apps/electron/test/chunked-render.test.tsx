// @vitest-environment jsdom
//
// 消息区冷加载分批渲染测试（全量渲染 + 分批追赶）。
//
// 聊天列表采用原生 DOM 全量渲染（StickToBottom），刷新/切换会话时
// timeline 一次性出现大量消息 → 按小批（每帧 CHUNK 条）渲染，避免
// 单帧提交数百条 markdown 高亮阻塞主线程。本文件验证：
//   - 冷加载：大批量消息首帧只渲染一小批，逐帧追赶至全量
//   - partial→full 快照：同一 sequence 的 full 替换 partial 后分批继续
//   - 小数据量直接完整渲染（不启动分批）

class ResizeObserverMock {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

import type { LookSessionEntry, SessionSnapshotEnvelope } from "@look/shared/types";
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
import { applySnapshot } from "../src/renderer/store/snapshot";

function entry(id: string, role: "user" | "assistant"): LookSessionEntry {
	return {
		type: "message",
		id,
		message: { role, content: role === "user" ? `user msg ${id}` : `assistant reply ${id}` },
	} as LookSessionEntry;
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
): SessionSnapshotEnvelope {
	return {
		type: "session:snapshot",
		sessionId,
		reason,
		sequence,
		leafId: null,
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

function renderWithSnapshot(entries: LookSessionEntry[], sequence = 1) {
	act(() => {
		applySnapshot(snapshot("session-a", sequence, entries));
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
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("renders a large cold history in small per-frame chunks instead of one burst", () => {
		renderWithSnapshot(makeEntries(60));

		// 首批只提交一帧的 CHUNK 条，而不是全量 60 条。
		const first = countMessages();
		expect(first).toBeGreaterThan(0);
		expect(first).toBeLessThan(60);

		// 推进若干帧，分批逐步追上全量。
		for (let i = 0; i < 30 && countMessages() < 60; i += 1) {
			act(() => {
				vi.advanceTimersByTime(16);
			});
		}
		expect(countMessages()).toBe(60);
	});

	it("keeps chunking when a deferred full snapshot replaces the partial one", () => {
		const { rerender } = renderWithSnapshot(makeEntries(40), 2);
		const afterPartial = countMessages();
		expect(afterPartial).toBeGreaterThan(0);
		expect(afterPartial).toBeLessThan(40);

		// full：同一 sequence 的全量 120 条随后到达，分批必须继续而不是单帧全量提交。
		act(() => {
			applySnapshot(snapshot("session-a", 2, makeEntries(120), "activate"));
		});
		rerender(listUi(appStore.get(sessionStateAtomFamily("session-a"))));
		const afterFull = countMessages();
		expect(afterFull).toBeGreaterThan(0);
		expect(afterFull).toBeLessThan(120);

		for (let i = 0; i < 40 && countMessages() < 120; i += 1) {
			act(() => {
				vi.advanceTimersByTime(16);
			});
		}
		expect(countMessages()).toBe(120);
	});

	it("renders small histories immediately without chunking", () => {
		renderWithSnapshot(makeEntries(5), 3);
		expect(countMessages()).toBe(5);
	});
});
