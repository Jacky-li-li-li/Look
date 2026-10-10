import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { checkIpcSender, isAppRendererUrl } from "../../src/main/ipc/sender-guard.js";

const entry = path.resolve("/app/dist/renderer/index.html");
const packaged = { isPackaged: true, packagedEntryPath: entry };
const dev = { isPackaged: false, packagedEntryPath: entry };
const entryUrl = `${pathToFileURL(entry).href}?theme=a&tone=dark`;
const trusted = new Set([1, 2]);

describe("isAppRendererUrl", () => {
	it("packaged: only the renderer entry file", () => {
		expect(isAppRendererUrl(entryUrl, packaged)).toBe(true);
		expect(isAppRendererUrl(pathToFileURL("/tmp/evil.html").href, packaged)).toBe(false);
		expect(isAppRendererUrl("http://localhost:5174/", packaged)).toBe(false);
		expect(isAppRendererUrl("https://example.com/", packaged)).toBe(false);
	});
	it("dev: only the vite dev origin", () => {
		expect(isAppRendererUrl("http://localhost:5174/?mode=file-viewer", dev)).toBe(true);
		expect(isAppRendererUrl("http://localhost:5175/", dev)).toBe(false);
		expect(isAppRendererUrl(entryUrl, dev)).toBe(false);
		expect(isAppRendererUrl("not a url", dev)).toBe(false);
	});
});

describe("checkIpcSender", () => {
	const ev = (id: number, url: string, parent: unknown = null) => ({ sender: { id }, senderFrame: { url, parent } });
	it("accepts trusted top-level app frame", () => {
		expect(checkIpcSender(ev(1, entryUrl), trusted, packaged)).toEqual({ ok: true });
		expect(checkIpcSender(ev(2, entryUrl), trusted, packaged).ok).toBe(true);
	});
	it("rejects unknown webContents", () => {
		expect(checkIpcSender(ev(99, entryUrl), trusted, packaged)).toEqual({
			ok: false,
			reason: "untrusted webContents",
		});
	});
	it("rejects sub-frames", () => {
		expect(checkIpcSender(ev(1, entryUrl, {}), trusted, packaged).ok).toBe(false);
	});
	it("rejects foreign origin in trusted webContents", () => {
		expect(checkIpcSender(ev(1, "https://evil.example/"), trusted, packaged).ok).toBe(false);
	});
	it("rejects missing frame", () => {
		expect(checkIpcSender({ sender: { id: 1 }, senderFrame: null }, trusted, packaged).ok).toBe(false);
	});
});
