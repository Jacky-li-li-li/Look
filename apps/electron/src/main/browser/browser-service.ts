// ============================================================
// Browser Service — puppeteer 浏览器生命周期管理
//
// 管理 Chromium 的启动、tab 创建、连接维护和资源回收。
// 实现 BrowserHost 接口，供 browser-extension 调用。
// ============================================================

import type { Browser, Page } from "puppeteer-core";
import { buildAriaSnapshotFunction, buildAriaSnapshotScript } from "./aria-snapshot.js";
import type {
	AriaSnapshot,
	BrowserHost,
	BrowserLaunchOptions,
	BrowserOpenOptions,
	BrowserRunResult,
	BrowserScreenshot,
	PageInfo,
} from "./types.js";

/** 单个浏览器的状态：一个 Browser 实例 + 多个命名 Page。 */
interface BrowserState {
	browser: Browser;
	headless: boolean;
	pages: Map<string, Page>;
}

/** 页面截图回调（通过 exposeFunction 暴露给页面，供 tab.screenshot 使用）。 */
interface PageScreenshotRequest {
	fullPage?: boolean;
}

export class BrowserService implements BrowserHost {
	private browsers = new Map<string, BrowserState>();
	private nextId = 1;
	/** 已暴露过 __look_screenshot 的 Page（puppeteer 重复 exposeFunction 会抛错，只首次注册）。 */
	private exposedScreenshotPages = new WeakSet<Page>();
	/** 当前 run 的截图收集器（按 Page 索引），已暴露的回调转发到这里，避免闭包持有单次调用状态。 */
	private screenshotCollectors = new Map<Page, BrowserScreenshot[]>();

	async launch(options: BrowserLaunchOptions = {}): Promise<string> {
		const { launch } = await import("./launch.js");
		const { browser, headless } = await launch(options);
		const handle = `browser-${this.nextId++}`;
		this.browsers.set(handle, { browser, headless, pages: new Map() });
		return handle;
	}

	async dispose(handle: string): Promise<void> {
		const state = this.browsers.get(handle);
		if (!state) return;
		try {
			await state.browser.close();
		} catch {
			// 关闭失败不阻塞清理
		}
		this.browsers.delete(handle);
	}

	async openTab(handle: string, tabName: string, options: BrowserOpenOptions = {}): Promise<PageInfo> {
		const state = this.getState(handle);
		const existing = state.pages.get(tabName);
		if (existing) {
			// Reuse existing tab
			if (options.url && existing.url() !== options.url) {
				await existing.goto(options.url, { waitUntil: options.waitUntil ?? "domcontentloaded" });
			}
			return this.pageInfo(existing);
		}
		const page = await state.browser.newPage();
		state.pages.set(tabName, page);
		if (options.url) {
			await page.goto(options.url, { waitUntil: options.waitUntil ?? "domcontentloaded" });
		}
		// Clean up when page closes
		page.on("close", () => {
			state.pages.delete(tabName);
		});
		return this.pageInfo(page);
	}

	async closeTab(handle: string, tabName: string): Promise<void> {
		const state = this.browsers.get(handle);
		if (!state) return;
		const page = state.pages.get(tabName);
		if (page && !page.isClosed()) {
			await page.close();
		}
		state.pages.delete(tabName);
		// 如果没 tab 了，不自动关浏览器——允许 agent 再 open 新 tab
	}

	async closeAllTabs(handle: string): Promise<number> {
		const state = this.browsers.get(handle);
		if (!state) return 0;
		let count = 0;
		for (const [name, page] of [...state.pages.entries()]) {
			try {
				if (!page.isClosed()) {
					await page.close();
					count++;
				}
			} catch {
				// 关闭失败的 tab 仍从 map 移除，但不计入成功数
			}
			state.pages.delete(name);
		}
		return count;
	}

	async snapshot(handle: string, tabName: string): Promise<AriaSnapshot> {
		const page = this.getPage(handle, tabName);
		const script = buildAriaSnapshotScript();
		const result = await page.evaluate(script);
		// Return as-is; it's already the right shape
		return result as unknown as AriaSnapshot;
	}

	async screenshot(handle: string, tabName: string, fullPage = false): Promise<BrowserScreenshot> {
		const page = this.getPage(handle, tabName);
		const buf = (await page.screenshot({ fullPage, type: "png" })) as Buffer;
		return {
			data: buf.toString("base64"),
			mimeType: "image/png",
			width: page.viewport()?.width ?? 1280,
			height: page.viewport()?.height ?? 720,
		};
	}

	/**
	 * 在 tab 中执行模型提供的 JS 代码。
	 *
	 * 页面脚本通过 `page.evaluate` 传入的字符串求值，页面内收集
	 * `display()` 输出与 `tab.screenshot()` 截图，随返回值一并交回
	 * 主进程——避免把函数暴露给任意网页（提示注入面）。
	 *
	 * @param timeoutMs 超时毫秒；超出后拒绝（页面内的死循环无法被
	 *   CDP 强杀，但主进程侧不再等待，避免工具永久挂起）。
	 */
	async run(handle: string, tabName: string, code: string, timeoutMs: number): Promise<BrowserRunResult> {
		const page = this.getPage(handle, tabName);

		const displays: Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }> = [];
		const screenshots: BrowserScreenshot[] = [];

		// 挂载本次收集器：已暴露的回调会从这里读取，闭包不持有单次调用状态。
		this.screenshotCollectors.set(page, screenshots);

		// 暴露截图能力到页面（仅截图；页面无法借此注入文本到模型可见输出）。
		// 只在首次调用时注册一次——puppeteer 对同一 Page 重复 exposeFunction
		// 会抛 `window['__look_screenshot'] already exists`，导致同一 tab 第二次
		// browser_run 必然失败。后续调用复用首次注册的回调，转发到上面的收集器。
		if (!this.exposedScreenshotPages.has(page)) {
			await page.exposeFunction("__look_screenshot", async (req: PageScreenshotRequest | undefined) => {
				const collector = this.screenshotCollectors.get(page);
				const buf = (await page.screenshot({
					fullPage: req?.fullPage ?? false,
					type: "png",
				})) as Buffer;
				const data = buf.toString("base64");
				collector?.push({
					data,
					mimeType: "image/png",
					width: page.viewport()?.width ?? 1280,
					height: page.viewport()?.height ?? 720,
				});
				return data;
			});
			this.exposedScreenshotPages.add(page);
		}

		// 页面脚本：纯字符串构建，内联快照函数与用户代码。
		// 注意：这里不是主进程 TypeScript 作用域，避免 `document` 等 DOM
		// 类型错误（主进程 tsconfig 不含 lib: dom）。
		const script = buildRunPageScript(code, buildAriaSnapshotFunction());

		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = (await Promise.race([
				page.evaluate(script),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`Browser run timed out after ${timeoutMs}ms`)), timeoutMs);
				}),
			])) as { returnValue?: unknown; displays?: unknown[] };
			if (timer) clearTimeout(timer);

			for (const item of result.displays ?? []) {
				if (typeof item === "string") {
					displays.push({ type: "text", text: item });
				} else {
					displays.push({ type: "text", text: JSON.stringify(item, null, 2) });
				}
			}

			return { displays, returnValue: result.returnValue, screenshots };
		} catch (error) {
			if (timer) clearTimeout(timer);
			displays.push({
				type: "text",
				text: `Browser run error: ${error instanceof Error ? error.message : String(error)}`,
			});
			// 超时可能是页面内同步死循环卡死了 JS 线程；主进程虽已放弃等待，
			// 但页面后续操作仍会一直超时。主动关掉该 tab，让下一次操作重建。
			if (error instanceof Error && error.message.includes("timed out")) {
				try {
					await this.closeTab(handle, tabName);
					displays.push({
						type: "text",
						text: "[tab was killed after timeout — reopen it with browser_open]",
					});
				} catch {
					// 关闭失败不阻塞错误返回
				}
			}
			return { displays, screenshots };
		} finally {
			this.screenshotCollectors.delete(page);
		}
	}

	isHeadless(handle: string): boolean {
		return this.browsers.get(handle)?.headless ?? true;
	}

	private getState(handle: string): BrowserState {
		const state = this.browsers.get(handle);
		if (!state) throw new Error(`Browser handle "${handle}" not found. Open a browser first.`);
		return state;
	}

	private getPage(handle: string, tabName: string): Page {
		const state = this.getState(handle);
		const page = state.pages.get(tabName);
		if (!page || page.isClosed()) {
			throw new Error(`Tab "${tabName}" not found. Open it first with browser_open.`);
		}
		return page;
	}

	private async pageInfo(page: Page): Promise<PageInfo> {
		const viewport = page.viewport();
		return {
			title: await page.title(),
			url: page.url(),
			viewport: viewport ? { width: viewport.width, height: viewport.height } : { width: 1280, height: 720 },
		};
	}
}

/**
 * 构建页面运行脚本（纯字符串）。
 *
 * 页面内提供 `tab` 辅助对象与 `display()`，用户代码通过
 * `new Function("display", "tab", userCode)` 求值；结果与页面内
 * 收集的 displays 一并返回。
 *
 * @param userCode 模型提供的 JS 代码字符串
 * @param ariaSnapshotFn buildAriaSnapshotFunction() 生成的函数声明字符串
 */
function buildRunPageScript(userCode: string, ariaSnapshotFn: string): string {
	// 用户代码内嵌到字符串（经 JSON 转义，避免引号破坏外层）。
	const codeJson = JSON.stringify(userCode);
	return `(async () => {
		${ariaSnapshotFn}
		const displays = [];
		const display = (v) => {
			displays.push(typeof v === "string" ? v : JSON.stringify(v, null, 2));
		};

		// React/Vue 等受控组件：直接赋值 el.value 不会触发框架 onChange。
		// 用原生 value setter 写入，再派发 input/change 事件。
		function setNativeValue(el, value) {
			const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
			const desc = Object.getOwnPropertyDescriptor(proto, "value");
			if (desc && desc.set) desc.set.call(el, value);
			else el.value = value;
		}

		const tab = {
			observe: () => {
				const s = __lookAriaSnapshot();
				display(s);
				return s;
			},
			click: async (sel) => {
				const el = document.querySelector(sel);
				if (!el) throw new Error("Element not found: " + sel);
				el.scrollIntoView({ block: "center" });
				el.click();
			},
			type: async (sel, text) => {
				const el = document.querySelector(sel);
				if (!el) throw new Error("Element not found: " + sel);
				el.focus();
				setNativeValue(el, "");
				for (const ch of String(text)) {
					setNativeValue(el, el.value + ch);
					el.dispatchEvent(new Event("input", { bubbles: true }));
				}
			},
			fill: async (sel, text) => {
				const el = document.querySelector(sel);
				if (!el) throw new Error("Element not found: " + sel);
				setNativeValue(el, String(text));
				el.dispatchEvent(new Event("input", { bubbles: true }));
				el.dispatchEvent(new Event("change", { bubbles: true }));
			},
			screenshot: async (opts) => window.__look_screenshot(opts),
			evaluate: (fn, ...args) => {
				const f = new Function("return (" + fn + ")")();
				return f(...args);
			},
			navigate: (url) => { location.href = url; },
			waitForSelector: (sel, opts) => {
				return new Promise((resolve, reject) => {
					const el = document.querySelector(sel);
					if (el) return resolve();
					const observer = new MutationObserver(() => {
						if (document.querySelector(sel)) {
							observer.disconnect();
							resolve();
						}
					});
					observer.observe(document.body, { childList: true, subtree: true });
					if (opts?.timeout) setTimeout(() => { observer.disconnect(); reject(new Error("Timeout waiting for " + sel)); }, opts.timeout);
				});
			},
			waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
			url: () => location.href,
			title: () => document.title,
		};

		const fn = new Function("display", "tab", ${codeJson});
		const returnValue = await fn(display, tab);
		return { returnValue, displays };
	})()`;
}
