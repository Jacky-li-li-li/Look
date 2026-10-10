// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { Provider } from "jotai";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (k: string) => k }),
	initReactI18next: { type: "3rdParty", init: vi.fn() },
}));
vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		loading: vi.fn(() => "tid"),
		dismiss: vi.fn(),
		success: vi.fn(),
		error: vi.fn(),
	}),
}));

import { useBranchForkActions } from "../src/renderer/components/chat/useBranchForkActions";
import { appStore } from "../src/renderer/store/appStore";
import { forkingEntryAtomFamily } from "../src/renderer/store/atoms";

describe("useBranchForkActions", () => {
	const scrollToMessage = vi.fn();
	const flashEntry = vi.fn();
	const onSend = vi.fn(async () => true);
	const inputRef = { current: { getText: () => "", setText: vi.fn(), focus: vi.fn() } };

	beforeEach(() => {
		scrollToMessage.mockClear();
		flashEntry.mockClear();
		appStore.set(forkingEntryAtomFamily("a1"), null);
		(window as unknown as { look: Record<string, unknown> }).look = {
			createFork: vi.fn(async () => ({ success: true, agentId: "a2" })),
			navigateTree: vi.fn(async () => ({ success: true, result: {} })),
		};
	});

	function wrap({ children }: { children: ReactNode }) {
		return <Provider store={appStore}>{children}</Provider>;
	}

	it("blocks branch when busy", () => {
		const { result } = renderHook(
			() =>
				useBranchForkActions({
					agentId: "a1",
					isBusy: true,
					inputRef: inputRef as never,
					onSend,
					scrollToMessage,
					flashEntry,
				}),
			{ wrapper: wrap },
		);
		act(() => {
			result.current.handleBranchFromHere("e1");
		});
		expect(result.current.pendingConfirm).toBeNull();
	});

	it("opens summary confirm when input empty", () => {
		const { result } = renderHook(
			() =>
				useBranchForkActions({
					agentId: "a1",
					isBusy: false,
					inputRef: inputRef as never,
					onSend,
					scrollToMessage,
					flashEntry,
				}),
			{ wrapper: wrap },
		);
		act(() => {
			result.current.handleBranchFromHere("e1");
		});
		expect(result.current.pendingConfirm).toEqual({ kind: "summary" });
	});

	it("fork resets forkingEntry on success", async () => {
		const { result } = renderHook(
			() =>
				useBranchForkActions({
					agentId: "a1",
					isBusy: false,
					inputRef: inputRef as never,
					onSend,
					scrollToMessage,
					flashEntry,
				}),
			{ wrapper: wrap },
		);
		await act(async () => {
			await result.current.handleForkToNewChat("e1");
		});
		expect(appStore.get(forkingEntryAtomFamily("a1"))).toBeNull();
	});
});
