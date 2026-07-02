// @vitest-environment jsdom
//
// Regression test for the scroll-to-bottom-on-launch behaviour and
// the virtual-scrolling architecture.
//
// Look now uses `react-virtuoso` (which was already a dependency).
// The library provides `followOutput` for streaming auto-scroll and
// `atBottomStateChange` for the floating scroll-to-bottom button.
// These replace the previous `use-stick-to-bottom` library.
//
// We pin the change in two ways:
//
//   1. ScrollToBottomButton — now accepts `isAtBottom` + `virtuosoRef`
//      props instead of pulling state from `useStickToBottomContext`.
//      Verified via component tests with props.
//   2. Static source check on ChatPanel — locks in react-virtuoso
//      as the scroll library and <Virtuoso> as the scroll container.
//      Catches accidental reverts to use-stick-to-bottom.

// ---- Module-level mocks ----------------------------------------------

class ResizeObserverMock {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

// No need to mock use-stick-to-bottom — the component no longer imports it.
// Jotai atoms used by ScrollToBottomButton are mocked implicitly by the
// happy-dom environment.

// ---- Imports --------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { Provider } from "jotai";
import { ScrollToBottomButton } from "../src/renderer/components/ChatPanel";
import type { VirtuosoHandle } from "react-virtuoso";

// ============================================================
// 1) ScrollToBottomButton
// ============================================================

describe("ScrollToBottomButton", () => {
	const fakeRef = createRef<VirtuosoHandle | null>();

	function wrap(node: React.ReactNode) {
		return <Provider>{node}</Provider>;
	}

	it("renders nothing when isAtBottom=true (user is at the bottom)", () => {
		const { container } = render(
			wrap(<ScrollToBottomButton isAtBottom={true} virtuosoRef={fakeRef} />),
		);
		expect(container.querySelector("button")).toBeNull();
	});

	it("renders the button when isAtBottom=false (user has scrolled up)", () => {
		const { container } = render(
			wrap(<ScrollToBottomButton isAtBottom={false} virtuosoRef={fakeRef} />),
		);
		const btn = container.querySelector("button");
		expect(btn).not.toBeNull();
		expect(btn?.getAttribute("aria-label")).toBe("Scroll to bottom");
	});
});

// ============================================================
// 2) Static source check
// ============================================================

describe("ChatMessageList source (scroll container wiring)", () => {
	const SRC = readFileSync(
		resolve(__dirname, "../src/renderer/components/ChatMessageList.tsx"),
		"utf8",
	);

	it("imports react-virtuoso for virtual scrolling", () => {
		expect(SRC).toMatch(/from\s+["']react-virtuoso["']/);
		expect(SRC).toMatch(/<Virtuoso\b/);
	});

	it("uses Virtuoso.followOutput for streaming auto-scroll", () => {
		expect(SRC).toMatch(/followOutput/);
	});

	it("uses Virtuoso.atBottomStateChange for the scroll button", () => {
		expect(SRC).toMatch(/atBottomStateChange/);
	});

	it("passes timeline data into Virtuoso so live item updates are explicit", () => {
		expect(SRC).toMatch(/data=\{timeline\}/);
		expect(SRC).toMatch(/computeItemKey/);
		expect(SRC).not.toMatch(/timelineRef/);
	});

	it("uses scrollToIndex for navigate-to-entry", () => {
		expect(SRC).toMatch(/scrollToIndex/);
	});

	it("no longer imports use-stick-to-bottom", () => {
		expect(SRC).not.toMatch(/from\s+["']use-stick-to-bottom["']/);
		expect(SRC).not.toMatch(/<StickToBottom\b/);
	});
});
