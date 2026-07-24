import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import { BrowserWindowEventTransport } from "../src/main/ipc/renderer-event-transport.js";

function makeWindow(options?: {
	destroyed?: boolean;
	webContentsDestroyed?: boolean;
	sendThrows?: boolean;
}): BrowserWindow {
	return {
		isDestroyed: () => options?.destroyed ?? false,
		webContents: {
			isDestroyed: () => options?.webContentsDestroyed ?? false,
			send: options?.sendThrows
				? vi.fn(() => {
						throw new Error("destroyed during send");
					})
				: vi.fn(),
		},
	} as unknown as BrowserWindow;
}

describe("BrowserWindowEventTransport", () => {
	it("delivers events to a live renderer window", () => {
		const window = makeWindow();
		const transport = new BrowserWindowEventTransport(() => window);

		expect(transport.send({ type: "update:checking" })).toBe(true);
		expect(window.webContents.send).toHaveBeenCalledWith("look:event", { type: "update:checking" });
	});

	it("drops events when the window disappears or is destroyed", () => {
		const missing = new BrowserWindowEventTransport(() => null);
		const destroyed = new BrowserWindowEventTransport(() => makeWindow({ destroyed: true }));
		const destroyedWebContents = new BrowserWindowEventTransport(() => makeWindow({ webContentsDestroyed: true }));

		expect(missing.send({ type: "update:checking" })).toBe(false);
		expect(destroyed.send({ type: "update:checking" })).toBe(false);
		expect(destroyedWebContents.send({ type: "update:checking" })).toBe(false);
	});

	it("contains a destroy race that occurs during delivery", () => {
		const transport = new BrowserWindowEventTransport(() => makeWindow({ sendThrows: true }));

		expect(transport.send({ type: "update:checking" })).toBe(false);
	});
});
