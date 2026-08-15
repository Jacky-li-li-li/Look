import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { BrowserHost, BrowserObservation, BrowserScreenshot } from "../src/main/browser/types";
import { createBrowserExtensionFactory } from "../src/main/extensions/browser-extension";
import { isApprovalRequiredTool } from "../src/main/extensions/tool-permission-registry";

type RegisteredTool = {
	name: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	execute: (...args: unknown[]) => Promise<{
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details: Record<string, unknown>;
		isError?: boolean;
	}>;
};

function createObservation(): BrowserObservation {
	return {
		generation: 1,
		title: "Example",
		url: "https://example.com",
		tree: '[1]<button name="Go" />\n[2]<input placeholder="Search" value="hello" />',
		elements: [
			{ index: 1, role: "button", name: "Go", tag: "button", attrs: 'name="Go"' },
			{ index: 2, role: "textbox", name: "", tag: "input", attrs: 'placeholder="Search" value="hello"' },
		],
		pageStats: { links: 0, interactive: 2, iframes: 0, shadowOpen: 0, shadowClosed: 0, images: 0, total: 2 },
		pageInfo: { pagesAbove: 0, pagesBelow: 0, viewportHeight: 720 },
	};
}

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
		observe: vi.fn(async () => createObservation()),
		screenshot: vi.fn(async () => screenshot),
		click: vi.fn(async () => {}),
		fill: vi.fn(async () => {}),
		press: vi.fn(async () => {}),
		scroll: vi.fn(async () => {}),
		waitFor: vi.fn(async () => true),
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
	it("registers the ten browser_* tools", () => {
		const { tools } = captureRegisteredTools();
		expect([...tools.keys()].sort()).toEqual([
			"browser_click",
			"browser_close",
			"browser_fill",
			"browser_open",
			"browser_press",
			"browser_run",
			"browser_screenshot",
			"browser_scroll",
			"browser_snapshot",
			"browser_wait_for",
		]);
	});

	it("every browser tool carries promptGuidelines for the system prompt", () => {
		const { tools } = captureRegisteredTools();
		for (const [name, tool] of tools) {
			expect(tool.promptGuidelines, `${name} should define promptGuidelines`).toBeDefined();
			expect(tool.promptGuidelines!.length, `${name} promptGuidelines should be non-empty`).toBeGreaterThan(0);
		}
	});

	it("browser_open guidelines cover when-to-use, trust, and untrusted page content", () => {
		const { tools } = captureRegisteredTools();
		const joined = tools.get("browser_open")!.promptGuidelines!.join("\n");
		expect(joined).toContain("browser_* 工具");
		expect(joined).toContain("项目信任");
		expect(joined).toContain("不可信输入");
	});

	it("browser_snapshot guidelines mandate snapshot-before-interact and index usage", () => {
		const { tools } = captureRegisteredTools();
		const joined = tools.get("browser_snapshot")!.promptGuidelines!.join("\n");
		expect(joined).toContain("[index]");
		expect(joined).toContain("重新快照");
		expect(joined).toContain("不要猜测");
	});

	it("browser_run guidelines position it as last resort with security constraints", () => {
		const { tools } = captureRegisteredTools();
		const joined = tools.get("browser_run")!.promptGuidelines!.join("\n");
		expect(joined).toContain("最后手段");
		expect(joined).toContain("Cookie");
		expect(joined).toContain("诱导的脚本");
	});

	it("declares side-effect tools for approval but not read-only ones", () => {
		captureRegisteredTools();
		for (const name of [
			"browser_open",
			"browser_close",
			"browser_click",
			"browser_fill",
			"browser_press",
			"browser_scroll",
			"browser_wait_for",
			"browser_run",
		]) {
			expect(isApprovalRequiredTool(name)).toBe(true);
		}
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
			url: "http://example.com/path",
			waitUntil: "domcontentloaded",
		});
		const https = await tools.get("browser_open")!.execute("call-2", { url: "https://example.com" });
		expect(https.isError).toBeFalsy();
		expect(host.openTab).toHaveBeenCalledWith("browser-1", "main", {
			url: "https://example.com",
			waitUntil: "domcontentloaded",
		});
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

	it("browser_snapshot renders the serialized tree with stats and scroll hints", async () => {
		const host = createFakeHost({
			observe: vi.fn(async () => ({
				...createObservation(),
				pageInfo: { pagesAbove: 0, pagesBelow: 2.5, viewportHeight: 720 },
			})),
		});
		const { tools } = captureRegisteredTools(host);
		await tools.get("browser_open")!.execute("call-1", {});
		const result = await tools.get("browser_snapshot")!.execute("call-2", {});
		const text = result.content.find((b) => b.type === "text")!.text!;
		expect(text).toContain("[1]<button");
		expect(text).toContain("[2]<input");
		expect(text).toContain("2 interactive");
		expect(text).toContain("page(s) below");
		expect((result.details.elements as unknown[]).length).toBe(2);
	});

	it("browser_snapshot reports when no browser is open", async () => {
		const { tools } = captureRegisteredTools();
		const result = await tools.get("browser_snapshot")!.execute("call-1", {});
		expect(result.isError).toBe(true);
	});

	it("browser_click forwards the snapshot index", async () => {
		const { tools, host } = captureRegisteredTools();
		await tools.get("browser_open")!.execute("call-1", {});
		const result = await tools.get("browser_click")!.execute("call-2", { index: 3 });
		expect(host.click).toHaveBeenCalledWith("browser-1", "main", 3);
		expect(result.details).toMatchObject({ index: 3 });
	});

	it("browser_click rejects invalid indexes", async () => {
		const { tools, host } = captureRegisteredTools();
		await tools.get("browser_open")!.execute("call-1", {});
		for (const bad of [0, -1, 1.5, "3"]) {
			const result = await tools.get("browser_click")!.execute("call-2", { index: bad });
			expect(result.isError).toBe(true);
		}
		expect(host.click).not.toHaveBeenCalled();
	});

	it("browser_fill forwards index and text", async () => {
		const { tools, host } = captureRegisteredTools();
		await tools.get("browser_open")!.execute("call-1", {});
		const result = await tools.get("browser_fill")!.execute("call-2", { index: 2, text: "hello world" });
		expect(host.fill).toHaveBeenCalledWith("browser-1", "main", 2, "hello world");
		expect(result.details).toMatchObject({ index: 2, length: 11 });
	});

	it("browser_press forwards the key", async () => {
		const { tools, host } = captureRegisteredTools();
		await tools.get("browser_open")!.execute("call-1", {});
		const result = await tools.get("browser_press")!.execute("call-2", { key: "Enter" });
		expect(host.press).toHaveBeenCalledWith("browser-1", "main", "Enter");
		expect(result.isError).toBeFalsy();
	});

	it("browser_scroll forwards direction, pages, and optional index", async () => {
		const { tools, host } = captureRegisteredTools();
		await tools.get("browser_open")!.execute("call-1", {});
		const result = await tools.get("browser_scroll")!.execute("call-2", { direction: "up", pages: 2, index: 4 });
		expect(host.scroll).toHaveBeenCalledWith("browser-1", "main", "up", 2, 4);
		expect(result.isError).toBeFalsy();
	});

	it("browser_wait_for forwards condition and timeout, reports timeout as error", async () => {
		const { tools, host } = captureRegisteredTools();
		await tools.get("browser_open")!.execute("call-1", {});
		const ok = await tools.get("browser_wait_for")!.execute("call-2", { kind: "text", value: "hello" });
		expect(host.waitFor).toHaveBeenCalledWith("browser-1", "main", { kind: "text", value: "hello" }, 10_000);
		expect(ok.isError).toBeFalsy();

		const timedOutHost = createFakeHost({ waitFor: vi.fn(async () => false) });
		const { tools: t2 } = captureRegisteredTools(timedOutHost);
		await t2.get("browser_open")!.execute("call-1", {});
		const timeout = await t2
			.get("browser_wait_for")!
			.execute("call-2", { kind: "selector", value: "#x", timeoutMs: 500 });
		expect(timeout.isError).toBe(true);
		expect(timeout.content[0].text).toContain("Timed out");
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
