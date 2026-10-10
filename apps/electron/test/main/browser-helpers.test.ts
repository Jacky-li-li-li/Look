import { describe, expect, it } from "vitest";
import { buildPartition, NAV_KEY_MAP, pngSizeFromHeader } from "../../src/main/browser/browser-helpers.js";

describe("browser-helpers", () => {
	it("buildPartition is stable and handle-scoped", () => {
		expect(buildPartition("h1")).toMatch(/^look-browser-[0-9a-f]{16}$/);
		expect(buildPartition("h1")).toBe(buildPartition("h1"));
		expect(buildPartition("h1")).not.toBe(buildPartition("h2"));
	});

	it("NAV_KEY_MAP covers Enter/Escape", () => {
		expect(NAV_KEY_MAP.Enter).toEqual({ code: "Enter", windowsVirtualKeyCode: 13 });
		expect(NAV_KEY_MAP.Escape.windowsVirtualKeyCode).toBe(27);
	});

	it("pngSizeFromHeader reads IHDR", () => {
		const buf = Buffer.alloc(24);
		buf.writeUInt32BE(0x49484452, 12);
		buf.writeUInt32BE(1280, 16);
		buf.writeUInt32BE(720, 20);
		expect(pngSizeFromHeader(buf)).toEqual({ width: 1280, height: 720 });
		expect(pngSizeFromHeader(Buffer.alloc(8))).toEqual({ width: 0, height: 0 });
	});
});
