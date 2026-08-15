// ============================================================
// Browser Service — puppeteer 浏览器生命周期管理
//
// 管理 Chromium 的启动、tab 创建、连接维护和资源回收。
// 实现 BrowserHost 接口，供 browser-extension 调用。
//
// 交互设计参考 browser-use：
//   - observe() 返回带 [index] 编号的序列化 DOM 树；
//   - click/fill/press 通过 data-look-ref 定位元素，再走
//     puppeteer 的真实鼠标/键盘事件（CDP Input），对受控组件
//     兼容性优于页面内 el.click()/value setter；
//   - 导航/重渲染后 data-look-ref 被移除，交互自动报错，
//     要求重新 observe（天然世代失效）。
// ============================================================

import type { Browser, Page } from "puppeteer-core";
import { buildDomSnapshotFunction, buildDomSnapshotScript, LOOK_REF_ATTRIBUTE } from "./dom-snapshot.js";
import type {
	BrowserHost,
	BrowserLaunchOptions,
	BrowserObservation,
	BrowserOpenOptions,
	BrowserRunResult,
	BrowserScreenshot,
	BrowserScrollDirection,
	BrowserWaitCondition,
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

/** 键盘按键输入类型（puppeteer KeyInput 的收窄子集）。 */
type PressKeyInput =
	| "Enter"
	| "Tab"
	| "Escape"
	| "Backspace"
	| "Delete"
	| "ArrowUp"
	| "ArrowDown"
	| "ArrowLeft"
	| "ArrowRight"
	| "Home"
	| "End"
	| "PageUp"
	| "PageDown"
	| "Space";

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

	/** 观察页面：序列化 DOM 树 + 元素索引 + 页面统计。 */
	async observe(handle: string, tabName: string): Promise<BrowserObservation> {
		const page = this.getPage(handle, tabName);
		const script = buildDomSnapshotScript();
		const result = (await page.evaluate(script)) as {
			title?: string;
			url?: string;
			tree?: string;
			elements?: BrowserObservation["elements"];
			pageStats?: BrowserObservation["pageStats"];
			pageInfo?: BrowserObservation["pageInfo"];
		};
		return {
			generation: this.nextGeneration(page),
			title: result.title ?? "",
			url: result.url ?? page.url(),
			tree: result.tree ?? "",
			elements: result.elements ?? [],
			pageStats: result.pageStats ?? {
				links: 0,
				interactive: 0,
				iframes: 0,
				shadowOpen: 0,
				shadowClosed: 0,
				images: 0,
				total: 0,
			},
			pageInfo: result.pageInfo ?? { pagesAbove: 0, pagesBelow: 0, viewportHeight: 720 },
		};
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
	 * 点击快照中的元素（真实鼠标事件）。
	 * 通过 data-look-ref 定位；导航/重渲染后属性消失会抛错，要求重新观察。
	 */
	async click(handle: string, tabName: string, index: number): Promise<void> {
		const page = this.getPage(handle, tabName);
		const element = await this.resolveRef(page, index);
		await element.scrollIntoView();
		// puppeteer click 内部走 CDP Input.dispatchMouseEvent，真实事件序列。
		await element.click({ delay: 30 });
	}

	/** 在快照元素中整段填写文本（真实键盘事件：聚焦 → 全选 → 输入）。 */
	async fill(handle: string, tabName: string, index: number, text: string): Promise<void> {
		if (text.length > 10_000) throw new Error("单次输入不能超过 10000 个字符。");
		const page = this.getPage(handle, tabName);
		const element = await this.resolveRef(page, index);
		await element.scrollIntoView();
		await element.click();
		const modifier = process.platform === "darwin" ? "Meta" : "Control";
		await page.keyboard.down(modifier as never);
		await page.keyboard.press("a");
		await page.keyboard.up(modifier as never);
		await page.keyboard.type(text, { delay: 5 });
	}

	/** 按下导航键（Enter/Tab/Escape/方向键等）或向聚焦元素输入文本。 */
	async press(handle: string, tabName: string, key: string): Promise<void> {
		if (!key) throw new Error("press 需要按键或文本。");
		const page = this.getPage(handle, tabName);
		const NAV_KEYS = new Set([
			"Enter",
			"Tab",
			"Escape",
			"Backspace",
			"Delete",
			"ArrowUp",
			"ArrowDown",
			"ArrowLeft",
			"ArrowRight",
			"Home",
			"End",
			"PageUp",
			"PageDown",
			"Space",
		]);
		if (NAV_KEYS.has(key)) {
			await page.keyboard.press(key as PressKeyInput);
		} else {
			// 其余按完整文本插入到聚焦元素（支持空格/标点/Unicode/换行）。
			if (key.length > 10_000) throw new Error("单次输入不能超过 10000 个字符。");
			await page.keyboard.type(key, { delay: 5 });
		}
	}

	/** 滚动页面或指定元素。 */
	async scroll(
		handle: string,
		tabName: string,
		direction: BrowserScrollDirection,
		pages = 1,
		index?: number,
	): Promise<void> {
		const page = this.getPage(handle, tabName);
		if (index !== undefined) {
			await this.resolveRef(page, index);
			// 页面内执行：滚动一个视口高度（字符串脚本，主进程无 DOM 类型）
			const dir = direction === "down" ? 1 : -1;
			const selector = `[${LOOK_REF_ATTRIBUTE}="${index}"]`;
			await page.evaluate(
				`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollBy({ top: ${dir} * el.clientHeight, behavior: "smooth" }); return true; })()`,
			);
			return;
		}
		const deltaY =
			direction === "down" ? pages * (page.viewport()?.height ?? 720) : -pages * (page.viewport()?.height ?? 720);
		await page.mouse.wheel({ deltaY });
	}

	/** 等待页面满足条件（URL 片段/可见文本/CSS selector），不执行模型 JS。 */
	async waitFor(
		handle: string,
		tabName: string,
		condition: BrowserWaitCondition,
		timeoutMs: number,
	): Promise<boolean> {
		if (!condition.value.trim()) throw new Error("等待条件不能为空。");
		if (!Number.isFinite(timeoutMs) || timeoutMs < 250) throw new Error("等待超时不能小于 250ms。");
		const page = this.getPage(handle, tabName);
		const payload = JSON.stringify(condition)
			.replace(/\u2028/g, "\\u2028")
			.replace(/\u2029/g, "\\u2029");
		const expression = `(() => {
			const condition = ${payload};
			try {
				if (condition.kind === "url") return location.href.includes(condition.value);
				if (condition.kind === "text") return (document.body?.innerText || "").includes(condition.value);
				return !!document.querySelector(condition.value);
			} catch { return false; }
		})()`;
		const startedAt = Date.now();
		while (Date.now() - startedAt <= timeoutMs) {
			const result = await page.evaluate(expression);
			if (result === true) return true;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		return false;
	}

	/**
	 * 在 tab 中执行模型提供的 JS 代码（高级兜底）。
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
		const script = buildRunPageScript(code, buildDomSnapshotFunction());

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

	private generationByPage = new WeakMap<Page, number>();

	/** 每次 observe 递增代际，供扩展层展示/校验。 */
	private nextGeneration(page: Page): number {
		const next = (this.generationByPage.get(page) ?? 0) + 1;
		this.generationByPage.set(page, next);
		return next;
	}

	/**
	 * 通过快照 index 定位元素。元素必须带 data-look-ref 标记——
	 * 导航/重渲染后标记消失，报错要求重新 observe。
	 */
	private async resolveRef(page: Page, index: number): Promise<import("puppeteer-core").ElementHandle<Element>> {
		if (!Number.isInteger(index) || index < 1)
			throw new Error("元素 index 必须是大于 0 的整数（来自 browser_snapshot 的 [index]）。");
		const element = await page.$(`[${LOOK_REF_ATTRIBUTE}="${index}"]`);
		if (!element) {
			throw new Error(
				`元素 [${index}] 不存在或已失效（页面可能已导航/重渲染）。请先重新调用 browser_snapshot 获取最新 index。`,
			);
		}
		return element;
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
 * `new Function("display", "tab", ...)` 求值；结果与页面内
 * 收集的 displays 一并返回。
 *
 * 用户代码被包装进 async 函数体（`return (async () => { ... })()`），
 * 因此代码内可以使用 `await tab.click(...)` 等异步交互——tab 的
 * click/fill/screenshot/waitForSelector 都返回 Promise。
 * 注意：用户代码经 JSON 转义后先作为字符串值取出，再拼接进函数体
 * 源码，避免引号/反斜杠破坏外层模板。
 *
 * @param userCode 模型提供的 JS 代码字符串
 * @param domSnapshotFn buildDomSnapshotFunction() 生成的函数声明字符串
 */
function buildRunPageScript(userCode: string, domSnapshotFn: string): string {
	// 用户代码作为字符串字面量嵌入（JSON 转义，避免引号破坏外层模板），
	// 页面内先取回字符串值，再拼进 async 函数体源码。
	const codeJson = JSON.stringify(userCode);
	return `(async () => {
		${domSnapshotFn}
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

		// 快照 index -> Element 映射：由 __lookDomSnapshot() 在每次快照时
		// 重建到 window.__lookAriaElements（见 dom-snapshot.ts）。
		// tab.click(index)/type(index)/fill(index) 借此用快照编号定位元素。
		const tab = {
			observe: () => {
				const s = __lookDomSnapshot();
				display(s);
				return s;
			},
			click: async (index) => {
				const el = (window.__lookAriaElements || [])[index];
				if (!el) throw new Error("Element not found for snapshot index: " + index);
				el.scrollIntoView({ block: "center" });
				el.click();
			},
			type: async (index, text) => {
				const el = (window.__lookAriaElements || [])[index];
				if (!el) throw new Error("Element not found for snapshot index: " + index);
				el.focus();
				setNativeValue(el, "");
				for (const ch of String(text)) {
					setNativeValue(el, el.value + ch);
					el.dispatchEvent(new Event("input", { bubbles: true }));
				}
			},
			fill: async (index, text) => {
				const el = (window.__lookAriaElements || [])[index];
				if (!el) throw new Error("Element not found for snapshot index: " + index);
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

		const userCode = ${codeJson};
		const fn = new Function("display", "tab", "return (async () => {" + userCode + "\\n})()");
		const returnValue = await fn(display, tab);
		return { returnValue, displays };
	})()`;
}
