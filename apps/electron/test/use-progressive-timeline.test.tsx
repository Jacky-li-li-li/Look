// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHUNK_SIZE, useProgressiveTimeline } from "../src/renderer/components/chat/useProgressiveTimeline";

describe("useProgressiveTimeline", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"requestAnimationFrame",
			(cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16) as unknown as number,
		);
		vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("shows the full short timeline without progressive mode", () => {
		const { result } = renderHook(() => useProgressiveTimeline(3, "a:1:x"));
		expect(result.current.isProgressive).toBe(false);
		expect(result.current.renderCount).toBe(3);
	});

	it("starts progressive for long timelines and advances by CHUNK_SIZE", () => {
		const { result, rerender } = renderHook(
			({ len, key }: { len: number; key: string }) => useProgressiveTimeline(len, key),
			{ initialProps: { len: CHUNK_SIZE * 4, key: "a:1:x" } },
		);
		expect(result.current.isProgressive).toBe(true);
		expect(result.current.renderCount).toBe(CHUNK_SIZE);
		act(() => {
			vi.advanceTimersByTime(200);
		});
		rerender({ len: CHUNK_SIZE * 4, key: "a:1:x" });
		expect(result.current.renderCount).toBeGreaterThanOrEqual(CHUNK_SIZE * 2);
	});

	it("resets when historyKey changes", () => {
		const { result, rerender } = renderHook(
			({ len, key }: { len: number; key: string }) => useProgressiveTimeline(len, key),
			{ initialProps: { len: 40, key: "a:1:x" } },
		);
		act(() => {
			vi.advanceTimersByTime(500);
		});
		rerender({ len: 40, key: "a:2:y" });
		expect(result.current.renderCount).toBeLessThanOrEqual(CHUNK_SIZE * 2);
		expect(result.current.isProgressive).toBe(true);
	});
});
