import { afterEach, describe, expect, it, vi } from "vitest";
import { disposeThenQuit } from "../../src/main/system/quit-guard.js";

afterEach(() => vi.useRealTimers());

describe("disposeThenQuit", () => {
	it("quits normally after dispose resolves", async () => {
		const quit = vi.fn();
		const exit = vi.fn();
		await expect(disposeThenQuit({ dispose: async () => {}, quit, exit })).resolves.toBe("disposed");
		expect(quit).toHaveBeenCalledOnce();
		expect(exit).not.toHaveBeenCalled();
	});

	it("still quits when dispose rejects", async () => {
		const quit = vi.fn();
		const exit = vi.fn();
		const logger = { error: vi.fn() };
		const outcome = await disposeThenQuit({
			dispose: async () => {
				throw new Error("boom");
			},
			quit,
			exit,
			logger,
		});
		expect(outcome).toBe("failed");
		expect(quit).toHaveBeenCalledOnce();
		expect(exit).not.toHaveBeenCalled();
	});

	it("force-exits when dispose hangs past the deadline", async () => {
		vi.useFakeTimers();
		const quit = vi.fn();
		const exit = vi.fn();
		const logger = { error: vi.fn() };
		const p = disposeThenQuit({ dispose: () => new Promise(() => {}), quit, exit, timeoutMs: 5000, logger });
		await vi.advanceTimersByTimeAsync(5001);
		await expect(p).resolves.toBe("timeout");
		expect(exit).toHaveBeenCalledWith(0);
		expect(quit).not.toHaveBeenCalled();
	});
});
