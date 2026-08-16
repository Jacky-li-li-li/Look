import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BrowserCdpTimeoutError,
	BrowserOperationAbortedError,
	withBrowserCdpTimeout,
} from "../src/main/browser/browser-cdp.js";

// withBrowserCdpTimeout 是纯函数（browser-cdp.ts），直接单测：
// 超时 reject / abort 抛错 / 晚 settle 不 double-settle / 已 abort 立即失败。

describe("withBrowserCdpTimeout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves with the command result when it settles in time", async () => {
		const promise = withBrowserCdpTimeout(async () => "ok", "Test.method", 1_000);
		// 先挂断言再推进时间：command 是 async（微任务结算），提前挂 handler 避免
		// resolve 在无消费方时被误判
		const assertion = expect(promise).resolves.toBe("ok");
		await vi.advanceTimersByTimeAsync(50);
		await assertion;
	});

	it("rejects with BrowserCdpTimeoutError when the command never settles", async () => {
		const promise = withBrowserCdpTimeout(
			() => new Promise(() => {}), // never settles
			"Test.method",
			100,
		);
		const assertion = expect(promise).rejects.toBeInstanceOf(BrowserCdpTimeoutError);
		await vi.advanceTimersByTimeAsync(1_000);
		await assertion;
	});

	it("rejects with BrowserOperationAbortedError when the signal aborts", async () => {
		const controller = new AbortController();
		const promise = withBrowserCdpTimeout(() => new Promise(() => {}), "Test.method", 10_000, controller.signal);
		const assertion = expect(promise).rejects.toBeInstanceOf(BrowserOperationAbortedError);
		controller.abort();
		await assertion;
	});

	it("fails immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const command = vi.fn(async () => "should-not-run");
		const promise = withBrowserCdpTimeout(command, "Test.method", 100, controller.signal);
		await expect(promise).rejects.toBeInstanceOf(BrowserOperationAbortedError);
		expect(command).not.toHaveBeenCalled();
	});

	it("does not double-settle when the command resolves after the timeout", async () => {
		let resolveLater!: (v: string) => void;
		const promise = withBrowserCdpTimeout(
			() => new Promise<string>((resolve) => (resolveLater = resolve)),
			"Test.method",
			100,
		);
		const assertion = expect(promise).rejects.toBeInstanceOf(BrowserCdpTimeoutError);
		await vi.advanceTimersByTimeAsync(1_000);
		await assertion;
		// 晚到的 resolve 必须被安全忽略（settle 已触发，不 double-settle）
		resolveLater("late");
		await vi.advanceTimersByTimeAsync(10);
		expect(true).toBe(true);
	});

	it("propagates command errors", async () => {
		const promise = withBrowserCdpTimeout(
			async () => {
				throw new Error("boom");
			},
			"Test.method",
			1_000,
		);
		// 先挂断言（reject 在微任务结算），避免 unhandled rejection
		const assertion = expect(promise).rejects.toThrow("boom");
		await vi.advanceTimersByTimeAsync(10);
		await assertion;
	});

	it("clears the timer after settle so the process can exit", async () => {
		const promise = withBrowserCdpTimeout(async () => "ok", "Test.method", 10_000);
		const assertion = expect(promise).resolves.toBe("ok");
		await vi.advanceTimersByTimeAsync(10);
		await assertion;
		expect(vi.getTimerCount()).toBe(0);
	});
});
