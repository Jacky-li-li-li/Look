// ============================================================
// Browser Extension — pi SDK ExtensionFactory
//
// 注册 browser_* 工具，让 Agent 控制 headless/headed 浏览器：
//   - browser_open    打开新 tab 并可选导航到 URL
//   - browser_close   关闭 tab 或所有 tab
//   - browser_snapshot 获取页面 ARIA 可访问性快照
//   - browser_screenshot 截取页面或全页截图
//   - browser_run     在 tab 中执行 JS 代码（tab.click/screenshot等）
//
// 权限模型：
//   - browser_open/close/run 有副作用，走声明式权限拦截；
//   - browser_snapshot/screenshot 为只读，不拦截；
//   - browser_open 首次启动浏览器前执行项目信任检查
//     （resolveProjectTrust），未信任项目拒绝启动。
//
// 注入点：CompositionBuilder.buildExtensionFactories()。
// ============================================================

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BrowserHost, WaitUntil } from "../browser/types.js";
import { declareApprovalRequiredTool } from "./tool-permission-registry.js";

/** 有副作用、需要用户审批的操作工具。只读/snapshot/screenshot 不在此列。 */
const BROWSER_APPROVAL_TOOLS = ["browser_open", "browser_close", "browser_run"] as const;

const DEFAULT_TAB_NAME = "main";

/** 允许导航的 URL 协议（白名单，含冒号）。拒绝 file:/javascript:/data: 等本地/可执行协议。 */
const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:", "about:"]);

function assertSafeUrl(url: string | undefined): void {
	if (!url) return;
	const trimmed = url.trim();
	if (!trimmed) return;
	// 无协议前缀的裸地址（如 example.com）按 http 处理，直接放行；
	// 有协议前缀时必须命中白名单。
	const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
	if (schemeMatch && !ALLOWED_URL_PROTOCOLS.has(`${schemeMatch[1].toLowerCase()}:`)) {
		throw new Error(
			`Refusing to navigate to disallowed protocol "${schemeMatch[1]}:". Only http:, https: (or a bare domain) are allowed.`,
		);
	}
}

const WAIT_UNTIL_VALUES = ["load", "domcontentloaded", "networkidle0", "networkidle2"] as const;

// ── 参数 Schema ─────────────────────────────────────────────

const BrowserOpenParams = Type.Object({
	url: Type.Optional(Type.String({ description: "URL to navigate to after opening" })),
	name: Type.Optional(Type.String({ description: `Tab name for later reference (default: "${DEFAULT_TAB_NAME}")` })),
	waitUntil: Type.Optional(
		Type.Union(
			WAIT_UNTIL_VALUES.map((v) => Type.Literal(v)),
			{
				description: `Navigation wait condition (default: "domcontentloaded")`,
			},
		),
	),
	headless: Type.Optional(Type.Boolean({ description: "Run browser headless (default: true)" })),
});

const BrowserCloseParams = Type.Object({
	name: Type.Optional(Type.String({ description: `Tab name to close (default: "${DEFAULT_TAB_NAME}")` })),
	all: Type.Optional(Type.Boolean({ description: "Close all tabs when true" })),
});

const BrowserSnapshotParams = Type.Object({
	name: Type.Optional(Type.String({ description: `Tab name (default: "${DEFAULT_TAB_NAME}")` })),
});

const BrowserScreenshotParams = Type.Object({
	name: Type.Optional(Type.String({ description: `Tab name (default: "${DEFAULT_TAB_NAME}")` })),
	fullPage: Type.Optional(Type.Boolean({ description: "Capture full scrollable page (default: false)" })),
});

const BrowserRunParams = Type.Object({
	name: Type.Optional(Type.String({ description: `Tab name (default: "${DEFAULT_TAB_NAME}")` })),
	code: Type.String({
		description:
			"JavaScript code to run. Has access to: tab (with .observe(), .click(sel), .type(sel,text), .fill(sel,text), .evaluate(fn), .screenshot(), .navigate(url), .waitForSelector(sel), .waitForTimeout(ms), .url(), .title()) and display(value) to output results.",
	}),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 30)" })),
});

// ── 辅助函数 ────────────────────────────────────────────────

function toolError(message: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: { ...details, error: message },
		isError: true,
	};
}

function resolveTabName(params: { name?: string }): string {
	const n = params.name?.trim();
	return n ? n : DEFAULT_TAB_NAME;
}

function isTrusted(resolveProjectTrust: ((cwd: string) => boolean) | undefined, cwd?: string): boolean {
	// 无 cwd（非项目会话，如某些测试场景）或未提供检查函数时视为信任。
	// 注意：browser_open 本身仍在 BROWSER_APPROVAL_TOOLS 中，每次调用都要过
	// 用户审批闸门，因此这里放行不会绕过权限控制。
	if (!cwd || !resolveProjectTrust) return true;
	return resolveProjectTrust(cwd);
}

// ── Extension Factory ───────────────────────────────────────

export function createBrowserExtensionFactory(
	host: BrowserHost,
	resolveProjectTrust?: (cwd: string) => boolean,
	cwd?: string,
): ExtensionFactory {
	return (api) => {
		// 声明式权限：副作用工具走 permission-extension 拦截
		for (const name of BROWSER_APPROVAL_TOOLS) declareApprovalRequiredTool(name);

		let browserHandle: string | null = null;

		api.on("session_shutdown", async () => {
			if (browserHandle) {
				await host.dispose(browserHandle).catch(() => {});
				browserHandle = null;
			}
		});

		// ── browser_open ──────────────────────────────────────────

		api.registerTool<typeof BrowserOpenParams, Record<string, unknown>>({
			name: "browser_open",
			label: "Open browser tab",
			description:
				"Open a new browser tab, optionally navigating to a URL. The tab is named for later reference with " +
				"browser_snapshot / browser_screenshot / browser_run. Reusing an existing tab name navigates it to " +
				"the new URL instead of creating a duplicate. The browser launches automatically on first use.",
			promptSnippet: "Open a browser tab and navigate to a URL",
			parameters: BrowserOpenParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal) {
				try {
					const tabName = resolveTabName(params);
					// 先校验 URL 协议再启动浏览器：非法协议不应拉起 Chromium。
					assertSafeUrl(params.url);

					// Lazy launch on first use; gate behind project trust.
					if (!browserHandle) {
						if (!isTrusted(resolveProjectTrust, cwd)) {
							return toolError("Project is not trusted. Refusing to launch a browser in an untrusted project.", {
								cwd,
							});
						}
						browserHandle = await host.launch({
							headless: params.headless ?? true,
							viewport: { width: 1280, height: 720 },
						});
					}

					const info = await host.openTab(browserHandle, tabName, {
						url: params.url,
						waitUntil: (params.waitUntil as WaitUntil | undefined) ?? "domcontentloaded",
					});

					const mode = host.isHeadless(browserHandle) ? "headless" : "visible";
					return {
						content: [
							{
								type: "text" as const,
								text: `Opened tab "${tabName}" on ${mode} browser.\nURL: ${info.url}\nTitle: ${info.title}\nViewport: ${info.viewport.width}×${info.viewport.height}`,
							},
						],
						details: { tabName, ...info },
					};
				} catch (error) {
					return toolError(error instanceof Error ? error.message : String(error), {
						tabName: resolveTabName(params),
					});
				}
			},
		});

		// ── browser_close ─────────────────────────────────────────

		api.registerTool<typeof BrowserCloseParams, Record<string, unknown>>({
			name: "browser_close",
			label: "Close browser tab",
			description:
				"Close a named tab, or all tabs. Closing all tabs does not stop the browser — use this to clean up " +
				"tabs you no longer need during a session.",
			promptSnippet: "Close a browser tab or all tabs",
			parameters: BrowserCloseParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal) {
				if (!browserHandle) return toolError("No browser is open.");
				try {
					if (params.all) {
						const count = await host.closeAllTabs(browserHandle);
						return {
							content: [{ type: "text" as const, text: `Closed ${count} tab(s).` }],
							details: { closed: count },
						};
					}
					const tabName = resolveTabName(params);
					await host.closeTab(browserHandle, tabName);
					return {
						content: [{ type: "text" as const, text: `Closed tab "${tabName}".` }],
						details: { tabName },
					};
				} catch (error) {
					return toolError(error instanceof Error ? error.message : String(error), {
						tabName: resolveTabName(params),
					});
				}
			},
		});

		// ── browser_snapshot ──────────────────────────────────────

		api.registerTool<typeof BrowserSnapshotParams, Record<string, unknown>>({
			name: "browser_snapshot",
			label: "Get page snapshot",
			description:
				"Capture an ARIA accessibility snapshot of the current page. Returns a flat list of interactive elements " +
				"(buttons, links, inputs, etc.) with their roles, names, and IDs. Use this to understand page structure " +
				"before interacting: pick element IDs from the snapshot and use them with browser_run to click/type. " +
				"Always snapshot before interacting — the page may have changed since the last observation.",
			promptSnippet: "Get a structured snapshot of the current page",
			parameters: BrowserSnapshotParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal) {
				if (!browserHandle) return toolError("No browser is open. Use browser_open first.");
				try {
					const tabName = resolveTabName(params);
					const snap = await host.snapshot(browserHandle, tabName);
					const lines = [`Page: ${snap.title}`, `URL: ${snap.url}`, `Elements: ${snap.elements.length}`, ""];
					for (const el of snap.elements.slice(0, 100)) {
						const name = el.name ? ` "${el.name}"` : "";
						const val = el.value ? ` = "${el.value}"` : "";
						const ph = el.placeholder ? ` placeholder="${el.placeholder}"` : "";
						const flags = [el.disabled && "[disabled]", el.checked && "[checked]"].filter(Boolean).join(" ");
						lines.push(`  #${el.id} <${el.role}>${name}${val}${ph} ${flags}`.trim());
					}
					if (snap.elements.length > 100) {
						lines.push(`  ... and ${snap.elements.length - 100} more elements`);
					}
					return {
						content: [{ type: "text" as const, text: lines.join("\n") }],
						details: snap as unknown as Record<string, unknown>,
					};
				} catch (error) {
					return toolError(error instanceof Error ? error.message : String(error), {
						tabName: resolveTabName(params),
					});
				}
			},
		});

		// ── browser_screenshot ────────────────────────────────────

		api.registerTool<typeof BrowserScreenshotParams, Record<string, unknown>>({
			name: "browser_screenshot",
			label: "Take page screenshot",
			description:
				"Take a screenshot of the current page (viewport or full page). Returns the image inline. " +
				"Use this to visually verify the page state after interactions.",
			promptSnippet: "Take a screenshot of the browser page",
			parameters: BrowserScreenshotParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal) {
				if (!browserHandle) return toolError("No browser is open. Use browser_open first.");
				try {
					const tabName = resolveTabName(params);
					const shot = await host.screenshot(browserHandle, tabName, params.fullPage);
					return {
						content: [
							{ type: "image" as const, data: shot.data, mimeType: shot.mimeType },
							{
								type: "text" as const,
								text: `Screenshot of tab "${tabName}"${params.fullPage ? " (full page)" : ""}. ${shot.width}×${shot.height}`,
							},
						],
						details: { tabName, width: shot.width, height: shot.height },
					};
				} catch (error) {
					return toolError(error instanceof Error ? error.message : String(error), {
						tabName: resolveTabName(params),
					});
				}
			},
		});

		// ── browser_run ───────────────────────────────────────────

		api.registerTool<typeof BrowserRunParams, Record<string, unknown>>({
			name: "browser_run",
			label: "Run code in browser",
			description:
				"Execute JavaScript code inside a browser tab. The code has access to:\n" +
				"  `tab.observe()` — ARIA snapshot (returns elements with id/role/name)\n" +
				"  `tab.click(selector)` — click an element by CSS selector\n" +
				"  `tab.type(selector, text)` — type into an input\n" +
				"  `tab.fill(selector, text)` — set input value directly\n" +
				"  `tab.screenshot()` — take viewport screenshot (returns base64 PNG)\n" +
				"  `tab.evaluate(fn)` — run JS in page context\n" +
				"  `tab.navigate(url)` — navigate to a URL\n" +
				"  `tab.waitForSelector(sel, {timeout?})` — wait for element\n" +
				"  `tab.waitForTimeout(ms)` — sleep\n" +
				"  `display(value)` — output a value to the result (text or JSON)\n" +
				"\n" +
				"Typical workflow: browser_snapshot → pick element IDs → browser_run to interact → browser_snapshot to verify.",
			promptSnippet: "Run JS code inside the browser tab to interact with the page",
			parameters: BrowserRunParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal) {
				if (!browserHandle) return toolError("No browser is open. Use browser_open first.");
				const tabName = resolveTabName(params);
				if (!params.code?.trim()) {
					return toolError("Missing required parameter 'code'.", { tabName });
				}
				try {
					const timeoutSeconds = params.timeout && params.timeout > 0 ? params.timeout : 30;
					const result = await host.run(browserHandle, tabName, params.code, timeoutSeconds * 1000);

					const content: Array<
						{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
					> = [];
					for (const item of result.displays) {
						if (item.type === "image" && item.data) {
							content.push({ type: "image", data: item.data, mimeType: item.mimeType ?? "image/png" });
						} else if (item.text) {
							content.push({ type: "text", text: item.text });
						}
					}
					// 如果有截图，附加最后一张
					if (result.screenshots && result.screenshots.length > 0) {
						const last = result.screenshots[result.screenshots.length - 1];
						content.push({ type: "image", data: last.data, mimeType: last.mimeType });
						content.push({ type: "text", text: `Screenshot captured (${last.width}×${last.height}).` });
					}
					if (result.returnValue !== undefined && content.length === 0) {
						const text =
							typeof result.returnValue === "string"
								? result.returnValue
								: JSON.stringify(result.returnValue, null, 2);
						content.push({ type: "text", text });
					}
					if (content.length === 0) {
						content.push({ type: "text", text: `Ran code on tab "${tabName}".` });
					}
					return {
						content,
						details: {
							tabName,
							displays: result.displays.length,
							screenshots: result.screenshots?.length ?? 0,
						},
					};
				} catch (error) {
					return toolError(error instanceof Error ? error.message : String(error), { tabName });
				}
			},
		});
	};
}
