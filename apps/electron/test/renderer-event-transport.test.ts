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

	describe("buffered startup mode", () => {
		it("queues events while buffering and replays them in order on flush", () => {
			const window = makeWindow();
			const transport = new BrowserWindowEventTransport(() => window);
			transport.buffer();

			expect(transport.send({ type: "project:list" })).toBe(true);
			expect(transport.send({ type: "agent:list" })).toBe(true);
			expect(window.webContents.send).not.toHaveBeenCalled();

			transport.flush();
			expect(window.webContents.send).toHaveBeenNthCalledWith(1, "look:event", { type: "project:list" });
			expect(window.webContents.send).toHaveBeenNthCalledWith(2, "look:event", { type: "agent:list" });
		});

		it("delivers immediately after flush (buffering is left off)", () => {
			const window = makeWindow();
			const transport = new BrowserWindowEventTransport(() => window);
			transport.buffer();
			transport.flush();

			expect(transport.send({ type: "update:checking" })).toBe(true);
			expect(window.webContents.send).toHaveBeenCalledWith("look:event", { type: "update:checking" });
		});

		it("still returns false for a missing window while buffering", () => {
			const transport = new BrowserWindowEventTransport(() => null);
			transport.buffer();

			expect(transport.send({ type: "project:list" })).toBe(false);
		});

		it("clear drops buffered events without delivering them", () => {
			const window = makeWindow();
			const transport = new BrowserWindowEventTransport(() => window);
			transport.buffer();
			transport.send({ type: "project:list" });

			transport.clear();
			transport.flush();
			expect(window.webContents.send).not.toHaveBeenCalled();
		});
	});
});
