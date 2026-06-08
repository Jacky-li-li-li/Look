// @vitest-environment jsdom
//
// Regression test for the "scroll-to-bottom-on-launch" bug.
//
// The original ChatPanel used `react-virtuoso` with
// `initialTopMostItemIndex` and a double-rAF effect. On app start / page
// refresh / session switch, the user's last message was not visible —
// the scroll bar was stranded in the middle of the list because Virtuoso
// applied the initial scroll position *before* dynamic-height items had
// been measured.
//
// Look now uses `use-stick-to-bottom` instead. The whole point of the
// switch is to make "land at the bottom" a single declarative prop
// (`initial="instant"`) that the library resolves on its own. We pin
// the change in three ways:
//
//   1. ScrollToBottomButton — hides at bottom, shows when user has
//      scrolled away. Verified via component test with a mocked context.
//   2. Static source check on ChatPanel — locks in the right library
//      and the right `initial` prop. Catches accidental reverts to
//      react-virtuoso or removal of `initial="instant"`.
//
// We do NOT run an integration test of the real <StickToBottom> in
// jsdom: jsdom doesn't run a layout engine, so scrollTop/scrollHeight
// are both 0, which makes the library's internal `isAtBottom` math
// meaningless in this environment. Manual dev-mode verification
// (npm run dev, switch sessions, refresh) is the right tool for the
// integration check.

// ---- Module-level mocks (must be declared before imports) -----------

// jsdom ships without ResizeObserver. The component being tested here
// does not require it (we mock the hook entirely), but importing
// `use-stick-to-bottom` pulls in the d.ts that references it, so we
// stub it globally to be safe.
class ResizeObserverMock {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

// Mock just the hook so we can swap its return value per-test. The
// ScrollToBottomButton tests need to control `isAtBottom` directly
// without setting up a real scroll container.
vi.mock("use-stick-to-bottom", async () => {
	const actual = await vi.importActual<typeof import("use-stick-to-bottom")>("use-stick-to-bottom");
	return {
		...actual,
		useStickToBottomContext: vi.fn(() => ({
			isAtBottom: true,
			escapedFromLock: false,
			scrollToBottom: () => {},
			stopScroll: () => {},
			scrollRef: { current: null },
			contentRef: { current: null },
			state: {} as never,
			get targetScrollTop(): null {
				return null;
			},
			set targetScrollTop(_: unknown): void {},
		})),
	};
});

// ---- Imports --------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { ScrollToBottomButton } from "../src/renderer/components/ChatPanel";

// ============================================================
// 1) ScrollToBottomButton — hides at bottom, shows when away
// ============================================================

describe("ScrollToBottomButton", () => {
	beforeEach(() => {
		vi.mocked(useStickToBottomContext).mockReset();
	});
	afterEach(() => {
		document.body.innerHTML = "";
	});

	function mockContext(overrides: Partial<ReturnType<typeof useStickToBottomContext>>) {
		const scrollToBottom = overrides.scrollToBottom ?? vi.fn();
		vi.mocked(useStickToBottomContext).mockReturnValue({
			isAtBottom: true,
			escapedFromLock: false,
			scrollToBottom,
			stopScroll: () => {},
			scrollRef: { current: null } as never,
			contentRef: { current: null } as never,
			state: {} as never,
			get targetScrollTop(): null {
				return null;
			},
			set targetScrollTop(_: unknown): void {},
			...overrides,
		});
		return { scrollToBottom };
	}

	it("renders nothing when isAtBottom=true (user is at the bottom)", () => {
		mockContext({ isAtBottom: true });
		const { container } = render(<ScrollToBottomButton />);
		expect(container.querySelector("button")).toBeNull();
	});

	it("renders the button when isAtBottom=false (user has scrolled up)", () => {
		const { scrollToBottom } = mockContext({
			isAtBottom: false,
			escapedFromLock: true,
		});
		const { container } = render(<ScrollToBottomButton />);
		const btn = container.querySelector("button");
		expect(btn).not.toBeNull();
		expect(btn?.getAttribute("aria-label")).toBe("Scroll to bottom");
		btn?.click();
		expect(scrollToBottom).toHaveBeenCalledTimes(1);
	});
});

// ============================================================
// 2) Static source check — pins the library and configuration
// ============================================================
//
// These assertions exist so that nobody can accidentally roll back the
// fix by re-introducing react-virtuoso or removing `initial="instant"`.
// They run as part of the test suite, are instant, and don't depend on
// a layout engine.

describe("ChatPanel source (scroll container wiring)", () => {
	const SRC = readFileSync(
		resolve(__dirname, "../src/renderer/components/ChatPanel.tsx"),
		"utf8",
	);

	it('imports the sticky-scroll library, not react-virtuoso', () => {
		expect(SRC).toMatch(/from\s+["']use-stick-to-bottom["']/);
		expect(SRC).not.toMatch(/from\s+["']react-virtuoso["']/);
		expect(SRC).not.toMatch(/<Virtuoso\b/);
	});

	it('uses <StickToBottom> with initial="instant" (the launch fix)', () => {
		expect(SRC).toMatch(/<StickToBottom\b/);
		// `initial="instant"` makes the library scroll to the bottom on
		// mount synchronously, bypassing the dynamic-height measurement
		// race that bit the old Virtuoso setup.
		expect(SRC).toMatch(/initial=["']instant["']/);
		// `resize="smooth"` is the user-facing nicety: streaming
		// messages animate into view rather than jump.
		expect(SRC).toMatch(/resize=["']smooth["']/);
	});

	it("no longer carries the old Virtuoso-era initial-scroll effect", () => {
		// The original buggy code had a 30-line useEffect that did
		// double-rAF + scrollToIndex({ index: "LAST", align: "end" }).
		// With use-stick-to-bottom that responsibility lives in the
		// library. If this string ever resurfaces, the fix has regressed.
		expect(SRC).not.toMatch(/scrollToIndex/);
		expect(SRC).not.toMatch(/needsInitialScrollRef/);
		expect(SRC).not.toMatch(/virtuosoRef/);
	});
});
