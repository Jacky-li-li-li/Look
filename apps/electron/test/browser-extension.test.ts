import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { BrowserHost, BrowserScreenshot } from "../src/main/browser/types";
import { createBrowserExtensionFactory } from "../src/main/extensions/browser-extension";
import { isApprovalRequiredTool } from "../src/main/extensions/tool-permission-registry";

type RegisteredTool = {
	name: string;
	execute: (...args: unknown[]) => Promise<{
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details: Record<string, unknown>;
		isError?: boolean;
	}>;
};

function createFakeHost(overrides: Partial<BrowserHost> = {}): BrowserHost {
	const screenshot: BrowserScreenshot = {
		data: "c2NyZWVuc2hvdA==",
		mimeType: "image/png",
		width: 1280,
		height: 720,
	};
	return {
		launch: vi.fn(async () => "browser-1"),
		dispose: vi.fn(async () => {}),
		openTab: vi.fn(async (_handle, tabName) => ({
			title: "Example",
			url: "https://example.com",
			viewport: { width: 1280, height: 720 },
		})),
		closeTab: vi.fn(async () => {}),
		closeAllTabs: vi.fn(async () => 2),
		snapshot: vi.fn(async () => ({
			timestamp: Date.now(),
			title: "Example",
			url: "https://example.com",
			elements: [
				{ id: 0, role: "button", name: "Go" },
				{ id: 1, role: "textbox", placeholder: "Search", value: "hello" },
			],
		})),
		screenshot: vi.fn(async () => screenshot),
		run: vi.fn(async () => ({
			displays: [{ type: "text", text: "ok" }],
			returnValue: 42,
			screenshots: [screenshot],
		})),
		isHeadless: vi.fn(() => true),
		...overrides,
	};
}

function captureRegisteredTools(
	host: BrowserHost = createFakeHost(),
	options?: { resolveProjectTrust?: (cwd: string) => boolean; cwd?: string },
) {
	const tools = new Map<string, RegisteredTool>();
	const eventHandlers = new Map<string, (event: unknown) => unknown>();
	const api = {
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		on: (event: string, handler: (e: unknown) => unknown) => eventHandlers.set(event, handler),
	};
	const factory = createBrowserExtensionFactory(host, options?.resolveProjectTrust, options?.cwd);
	factory(api as unknown as ExtensionAPI);
	return { tools, host, eventHandlers };
}

describe("Browser Extension", () => {
	it("registers the five browser_* tools", () => {
		const { tools } = captureRegisteredTools();
		expect([...tools.keys()].sort()).toEqual([
			"browser_close",
			"browser_open",
			"browser_run",
			"browser_screenshot",
			"browser_snapshot",
		]);
	});

	it("declares open/close/run for approval but not snapshot/screenshot", () => {
		captureRegisteredTools();
		expect(isApprovalRequiredTool("browser_open")).toBe(true);
		expect(isApprovalRequiredTool("browser_close")).toBe(true);
		expect(isApprovalRequiredTool("browser_run")).toBe(true);
		expect(isApprovalRequiredTool("browser_snapshot")).toBe(false);
		expect(isApprovalRequiredTool("browser_screenshot")).toBe(false);
	});

	it("browser_open lazily launches the browser and opens a tab", async () => {
		const { tools, host } = captureRegisteredTools();
		const result = await tools.get("browser_open")!.execute("call-1", { url: "https://example.com" });
		expect(host.launch).toHaveBeenCalledTimes(1);
		expect(host.openTab).toHaveBeenCalledWith("browser-1", "main", {
			url: "https://example.com",
			waitUntil: "domcontentloaded",
		});
		expect(result.details).toMatchObject({ tabName: "main", url: "https://example.com" });
	});

	it("browser_open refuses to launch in an untrusted project", async () => {
		const { tools, host } = captureRegisteredTools(createFakeHost(), {
			resolveProjectTrust: () => false,
			cwd: "/untrusted",
		});
		const result = await tools.get("browser_open")!.execute("call-1", { url: "https://example.com" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not trusted");
		expect(host.launch).not.toHaveBeenCalled();
	});

	it("browser_open rejects disallowed URL protocols", async () => {
		const { tools, host } = captureRegisteredTools();
		for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<h1>x</h1>"]) {
			const result = await tools.get("browser_open")!.execute("call-1", { url: bad });
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("disallowed protocol");
		}
		expect(host.launch).not.toHaveBeenCalled();
	});

	it("browser_open allows bare domains and http(s) URLs", async () => {
		const { tools, host } = captureRegisteredTools();
		const ok = await tools.get("browser_open")!.execute("call-1", { url: "example.com/path" });
		expect(ok.isError).toBeFalsy();
		expect(host.openTab).toHaveBeenCalledWith("browser-1", "main", {
			url: "example.com/path",
			waitUntil: "domcontentloaded",
		});
		const https = await tools.get("browser_open")!.execute("call-2", { url: "https://example.com" });
		expect(https.isError).toBeFalsy();
	});

	it("browser_open launches in a trusted project", async () => {
		const { tools, host } = captureRegisteredTools(createFakeHost(), {
			resolveProjectTrust: () => true,
			cwd: "/trusted",
		});
		const result = await tools.get("browser_open")!.execute("call-1", {});
		expect(result.isError).toBeFalsy();
		expect(host.launch).toHaveBeenCalledTimes(1);
	});

	it("browser_close closes a single tab and all tabs", async () => {
		const { tools, host } = captureRegisteredTools();
		// 先 open，使 handle 存在
		await tools.get("browser_open")!.execute("call-1", {});

		const single = await tools.get("browser_close")!.execute("call-2", { name: "main" });
		expect(host.closeTab).toHaveBeenCalledWith("browser-1", "main");
		expect(single.details).toMatchObject({ tabName: "main" });

		const all = await tools.get("browser_close")!.execute("call-3", { all: true });
		expect(host.closeAllTabs).toHaveBeenCalledWith("browser-1");
		expect(all.details).toMatchObject({ closed: 2 });
	});

	it("browser_close reports when no browser is open", async () => {
		const { tools } = captureRegisteredTools();
		const result = await tools.get("browser_close")!.execute("call-1", {});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("No browser is open");
	});

	it("browser_snapshot renders elements with flags and caps at 100", async () => {
		const host = createFakeHost({
			snapshot: vi.fn(async () => ({
				timestamp: Date.now(),
				title: "Example",
				url: "https://example.com",
				elements: Array.from({ length: 120 }, (_, i) => ({
					id: i,
					role: i % 2 === 0 ? "button" : "textbox",
					name: `el-${i}`,
				})),
			})),
		});
		const { tools } = captureRegisteredTools(host);
		await tools.get("browser_open")!.execute("call-1", {});
		const result = await tools.get("browser_snapshot")!.execute("call-2", {});
		const text = result.content.find((b) => b.type === "text")!.text!;
		expect(text).toContain("Elements: 120");
		expect(text).toContain("... and 20 more elements");
		expect((result.details.elements as unknown[]).length).toBe(120);
	});

	it("browser_snapshot reports when no browser is open", async () => {
		const { tools } = captureRegisteredTools();
		const result = await tools.get("browser_snapshot")!.execute("call-1", {});
		expect(result.isError).toBe(true);
	});

	it("browser_screenshot returns inline image plus text", async () => {
		const { tools } = captureRegisteredTools();
		await tools.get("browser_open")!.execute("call-1", {});
		const result = await tools.get("browser_screenshot")!.execute("call-2", { name: "main", fullPage: true });
		expect(result.content[0]).toMatchObject({ type: "image", data: "c2NyZWVuc2hvdA==", mimeType: "image/png" });
		expect(result.content[1].text).toContain("full page");
	});

	it("browser_run forwards code and timeout, and surfaces displays", async () => {
		const { tools, host } = captureRegisteredTools();
		await tools.get("browser_open")!.execute("call-1", {});
		const result = await tools.get("browser_run")!.execute("call-2", {
			code: "display('hi'); return 42;",
			timeout: 5,
		});
		expect(host.run).toHaveBeenCalledWith("browser-1", "main", "display('hi'); return 42;", 5000);
		expect(result.content[0].text).toBe("ok");
	});

	it("browser_run requires code", async () => {
		const { tools } = captureRegisteredTools();
		await tools.get("browser_open")!.execute("call-1", {});
		const result = await tools.get("browser_run")!.execute("call-2", {});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Missing required parameter 'code'");
	});

	it("browser_run surfaces screenshots after displays", async () => {
		const { tools } = captureRegisteredTools();
		await tools.get("browser_open")!.execute("call-1", {});
		const result = await tools.get("browser_run")!.execute("call-2", { code: "return 1;" });
		const images = result.content.filter((b) => b.type === "image");
		expect(images.length).toBe(1);
		expect(result.content.some((b) => b.type === "text" && b.text!.includes("Screenshot captured"))).toBe(true);
	});

	it("returns returnValue when no displays/screenshots exist", async () => {
		const host = createFakeHost({
			run: vi.fn(async () => ({ displays: [], returnValue: 7, screenshots: [] })),
		});
		const { tools } = captureRegisteredTools(host);
		await tools.get("browser_open")!.execute("call-1", {});
		const result = await tools.get("browser_run")!.execute("call-2", { code: "return 7;" });
		expect(result.content[0].text).toBe("7");
	});

	it("disposes the browser on session shutdown", async () => {
		const host = createFakeHost();
		const { tools, eventHandlers } = captureRegisteredTools(host);
		await tools.get("browser_open")!.execute("call-1", {});
		const shutdown = eventHandlers.get("session_shutdown");
		expect(shutdown).toBeDefined();
		await (shutdown as () => Promise<void>)();
		expect(host.dispose).toHaveBeenCalledWith("browser-1");
	});
});
