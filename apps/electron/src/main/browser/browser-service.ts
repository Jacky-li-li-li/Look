// ============================================================
// Browser Service — WebContentsView 浏览器生命周期管理
//
// 管理内置于主窗口的原生浏览器视图（Electron WebContentsView），
// 替代原先 puppeteer + 外部 Chromium 的方案：
//   - 每个 tab 是一个 WebContentsView，挂到主窗口 contentView，
//     面板打开时按 renderer 上报的布局 setBounds/setVisible；
//   - Agent 自动化走 WebContents.debugger（CDP）：observe 复用
//     dom-snapshot 页面脚本（data-look-ref），click/fill/press 走
//     CDP Input 真实事件；
//   - 实现 BrowserHost 接口，browser-extension 无需改动。
//
// 面板交互模型（Proma 式取舍）：
//   - 面板视图区显示真实网页（原生视图），用户直接交互，
//     不再需要截图流与坐标映射；
//   - renderer 的 BrowserSlot 持续测量占位 div 布局并上报
//     browser:set-layout，主进程据此同步原生视图边界；
//   - revision 全局单调递增，晚到的旧布局被忽略。
// ============================================================

import { createHash } from "node:crypto";
import type { BrowserViewLayout } from "@look/shared";
import {
	type BrowserWindow,
	session as electronSession,
	type NativeImage,
	type Session,
	WebContentsView,
} from "electron";
import {
	BROWSER_OBSERVE_TIMEOUT_MS,
	BrowserCdp,
	BrowserOperationAbortedError,
	throwIfBrowserOperationAborted,
	withBrowserCdpTimeout,
} from "./browser-cdp.js";
import { buildDomSnapshotFunction, buildDomSnapshotScript, LOOK_REF_ATTRIBUTE } from "./dom-snapshot.js";
import type {
	BrowserHost,
	BrowserLaunchOptions,
	BrowserObservation,
	BrowserOpenOptions,
	BrowserPanelAction,
	BrowserPanelState,
	BrowserPanelTabInfo,
	BrowserRunResult,
	BrowserScreenshot,
	BrowserScrollDirection,
	BrowserWaitCondition,
	DisplayItem,
	PageInfo,
	WaitUntil,
} from "./types.js";
import { normalizeNavigationUrl } from "./url-policy.js";

/** 单个 tab：一个 WebContentsView + CDP 通道 + 观察代际。 */
interface TabRecord {
	view: WebContentsView;
	cdp: BrowserCdp;
	/** 观察代际：导航/重渲染后递增，refs 随之失效。 */
	generation: number;
	/** 最近一次 setBounds（布局去抖：不变则跳过 setBounds）。 */
	lastBounds?: { x: number; y: number; width: number; height: number };
}

/** 一个浏览器会话（对应一个 BrowserHost handle）。 */
interface BrowserState {
	handle: string;
	/** launch 时的 headless 参数（WebContentsView 下视图始终存在，仅记录语义）。 */
	headless: boolean;
	/** 面板自启（非 agent 扩展持有）——close-panel 时回收。 */
	panelOwned: boolean;
	/** 独立 partition：会话间 cookie/profile 隔离。 */
	partition: string;
	tabs: Map<string, TabRecord>;
	/** 面板 newTab 命名递增计数器。 */
	nextTabId: number;
	/** 本会话已应用的最新布局 revision。 */
	lastLayoutRevision: number;
}

/** 当前前台原生视图（跨会话唯一）。 */
interface Presentation {
	handle: string;
	tab: string;
	revision: number;
}

/** 键盘按键 → CDP 事件映射（非字符导航键需要 code/vk 触发 Chromium 默认行为）。 */
const NAV_KEY_MAP: Record<string, { code: string; windowsVirtualKeyCode: number }> = {
	Enter: { code: "Enter", windowsVirtualKeyCode: 13 },
	Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
	Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
	Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
	Delete: { code: "Delete", windowsVirtualKeyCode: 46 },
	ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
	ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
	ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
	ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
	Home: { code: "Home", windowsVirtualKeyCode: 36 },
	End: { code: "End", windowsVirtualKeyCode: 35 },
	PageUp: { code: "PageUp", windowsVirtualKeyCode: 33 },
	PageDown: { code: "PageDown", windowsVirtualKeyCode: 34 },
	Space: { code: "Space", windowsVirtualKeyCode: 32 },
};

/** 会话 partition：按 handle 哈希，避免跨会话共享 cookie；非持久（会话级）。 */
function buildPartition(handle: string): string {
	const digest = createHash("sha256").update(handle).digest("hex").slice(0, 16);
	return `look-browser-${digest}`;
}

export class BrowserService implements BrowserHost {
	private owner: BrowserWindow | null = null;
	private browsers = new Map<string, BrowserState>();
	private nextId = 1;
	/** 面板自启（非 agent 扩展持有）的浏览器 handle——close-panel 时回收。 */
	private panelOwnedHandles = new Set<string>();
	/** 已装过网络 guard 的 Electron Session（partition 生命周期长于会话，只注册一次）。 */
	private guardedSessions = new WeakSet<Session>();

	// ---- 内置浏览器面板：活动目标跟踪 + 活动通知 ----
	/** 最近被 agent 工具触碰的浏览器会话与 tab（面板展示/交互的目标）。 */
	private activeHandle: string | null = null;
	private activeTab: string | null = null;
	/** 面板活动变更回调（agent 使用浏览器 / tab 变化时触发，由 IPC 层推给 renderer）。 */
	private activityListener: (() => void) | null = null;

	/** 跨会话唯一的前台原生视图所有权（controller 层保证，不依赖 renderer 卸载顺序）。 */
	private presentation: Presentation | null = null;
	/** 即使当前没有 Slot，也保留最新 show 代际以拒绝晚到的旧 show 布局。 */
	private latestPresentationRevision = 0;

	// ============================================================
	// 面板活动跟踪
	// ============================================================

	/** 注册面板活动变更通知（每次 agent 触碰浏览器/tab 变化时触发；传 null 取消）。 */
	onPanelActivity(listener: (() => void) | null): void {
		this.activityListener = listener;
	}

	private touchActive(handle: string, tabName: string): void {
		this.activeHandle = handle;
		this.activeTab = tabName;
		this.activityListener?.();
	}

	/** 返回活动目标（handle/tab）；无浏览器时返回 null。 */
	getActiveTarget(): { handle: string; tab: string } | null {
		if (!this.activeHandle || !this.activeTab) return null;
		const state = this.browsers.get(this.activeHandle);
		const tab = state?.tabs.get(this.activeTab);
		if (!tab || tab.view.webContents.isDestroyed()) return null;
		return { handle: this.activeHandle, tab: this.activeTab };
	}

	/** 绑定主窗口（WebContentsView 挂载目标；窗口重建后需重新调用）。 */
	setOwnerWindow(window: BrowserWindow): void {
		if (this.owner === window) return;
		this.owner = window;
		// 窗口恢复可见时重放最近一次前台布局：最小化/隐藏期间到达的布局上报会被
		// isVisible() 门吞掉（视图隐藏、revision 已推进），恢复后 renderer 的去抖
		// 不会再重发，必须由主进程主动恢复（见 replayPresentation）。
		window.on("show", () => this.replayPresentation());
		window.on("restore", () => this.replayPresentation());
		window.on("focus", () => this.replayPresentation());
	}

	/** 窗口重新可见时，把当前前台原生视图恢复到最近一次布局。 */
	private replayPresentation(): void {
		const presentation = this.presentation;
		if (!presentation || !this.owner?.isVisible()) return;
		const state = this.browsers.get(presentation.handle);
		const tab = state?.tabs.get(presentation.tab);
		if (!tab || tab.view.webContents.isDestroyed()) return;
		if (tab.lastBounds) tab.view.setBounds(tab.lastBounds);
		this.hideAllViewsExcept(presentation.handle, presentation.tab);
		tab.view.setVisible(true);
	}

	// ============================================================
	// 生命周期
	// ============================================================

	async launch(options: BrowserLaunchOptions = {}): Promise<string> {
		if (!this.owner || this.owner.isDestroyed()) throw new Error("主窗口尚未就绪，无法启动内置浏览器。");
		const handle = `browser-${this.nextId++}`;
		const state: BrowserState = {
			handle,
			headless: options.headless ?? true,
			panelOwned: false,
			partition: buildPartition(handle),
			tabs: new Map(),
			nextTabId: 1,
			lastLayoutRevision: 0,
		};
		this.installSessionGuards(electronSession.fromPartition(state.partition));
		this.browsers.set(handle, state);
		return handle;
	}

	/** 面板启动的浏览器：记录归属，面板关闭时回收（agent 扩展的实例不受影响）。 */
	async launchForPanel(): Promise<string> {
		const handle = await this.launch({ headless: true });
		const state = this.browsers.get(handle);
		if (state) state.panelOwned = true;
		this.panelOwnedHandles.add(handle);
		return handle;
	}

	/** 回收面板自启的浏览器实例（close-panel 时调用；agent 扩展的实例由 session_shutdown 负责）。 */
	async disposePanelBrowsers(): Promise<void> {
		for (const handle of [...this.panelOwnedHandles]) {
			await this.dispose(handle);
		}
	}

	/** open-panel force 启动的串行化队列：双击/竞态只启动一个 panel-owned 浏览器。 */
	private panelLaunchQueue: Promise<void> = Promise.resolve();

	/**
	 * 面板 force 打开：空闲时启动一个 panel-owned 空白页浏览器。
	 * 串行化（promise 链）保证并发调用只启动一个；openTab 失败时回收刚
	 * launch 的实例，避免残留无 tab 的孤儿浏览器。
	 */
	async launchForPanelIfIdle(): Promise<void> {
		const task = this.panelLaunchQueue.then(async () => {
			if (this.getActiveTarget() !== null) return;
			const handle = await this.launchForPanel();
			try {
				await this.openTab(handle, "main", { url: "about:blank" });
			} catch (error) {
				await this.dispose(handle).catch(() => {});
				throw error;
			}
		});
		// 失败不毒化队列：后续调用仍可在失败任务之后继续。
		this.panelLaunchQueue = task.catch(() => {});
		return task;
	}

	async dispose(handle: string): Promise<void> {
		const state = this.browsers.get(handle);
		if (!state) return;
		const wasActive = this.activeHandle === handle;
		for (const [name, tab] of [...state.tabs]) {
			try {
				tab.cdp.detach();
				if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
			} catch {
				// 关闭失败不阻塞清理
			}
			this.removeTabRecord(state, name, tab);
		}
		this.browsers.delete(handle);
		this.panelOwnedHandles.delete(handle);
		if (wasActive) {
			this.activeHandle = null;
			this.activeTab = null;
			// 面板状态刷新：agent 会话结束时清理活动目标，renderer 侧需要感知
			//（否则面板停留在死状态：显示已销毁的 tab、操作全部报错）。
			this.activityListener?.();
		}
	}

	// ============================================================
	// Tab 管理
	// ============================================================

	async openTab(handle: string, tabName: string, options: BrowserOpenOptions = {}): Promise<PageInfo> {
		const state = this.getState(handle);
		// 协议白名单收口：所有 openTab 调用方（agent 工具 / 面板 newTab）共用同一套校验。
		const url = normalizeNavigationUrl(options.url);
		this.touchActive(handle, tabName);
		const existing = state.tabs.get(tabName);
		if (existing) {
			if (url && existing.view.webContents.getURL() !== url) {
				await this.loadUrl(existing, url, undefined, options.waitUntil);
			}
			return this.pageInfo(existing);
		}
		const tab = this.createView(state, tabName);
		if (url) {
			await this.loadUrl(tab, url, undefined, options.waitUntil);
		}
		return this.pageInfo(tab);
	}

	async closeTab(handle: string, tabName: string): Promise<void> {
		const state = this.browsers.get(handle);
		if (!state) return;
		const tab = state.tabs.get(tabName);
		// 仅当被关 tab 是当前活动 tab 时才回退活动目标：关闭后台 tab 不应打断
		// 用户当前正在看的页面（面板无谓跳页）。
		const wasActive = this.activeHandle === handle && this.activeTab === tabName;
		if (tab) {
			try {
				tab.cdp.detach();
				if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
			} catch {
				// 已销毁
			}
			this.removeTabRecord(state, tabName, tab);
		}
		if (wasActive) {
			// 活动 tab 被关闭时回退到剩余的第一个 tab（或清空），面板保持跟随。
			const next = state.tabs.keys().next().value as string | undefined;
			this.activeTab = next ?? null;
		}
		// tab 列表已变化，无论是否活动 tab 都推送刷新。
		this.activityListener?.();
		// 如果没 tab 了，不自动关浏览器——允许 agent 再 open 新 tab
	}

	async closeAllTabs(handle: string): Promise<number> {
		const state = this.browsers.get(handle);
		if (!state) return 0;
		let count = 0;
		for (const [name, tab] of [...state.tabs]) {
			try {
				tab.cdp.detach();
				if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
				count++;
			} catch {
				// 关闭失败的 tab 仍从 map 移除
			}
			this.removeTabRecord(state, name, tab);
		}
		if (this.activeHandle === handle) {
			this.activeTab = null;
			this.activityListener?.();
		}
		return count;
	}

	/** 创建原生视图并挂到主窗口；初始隐藏，由布局桥接显示。 */
	private createView(state: BrowserState, tabName: string): TabRecord {
		if (!this.owner || this.owner.isDestroyed()) throw new Error("主窗口尚未就绪，无法创建浏览器标签。");
		const view = new WebContentsView({
			webPreferences: {
				partition: state.partition,
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
				webSecurity: true,
			},
		});
		this.owner.contentView.addChildView(view);
		view.setVisible(false);

		// 弹窗策略：页面 window.open / target=_blank 不弹独立 BrowserWindow——
		// 独立弹窗会逃出受管视图体系（不受 will-navigate 白名单约束、dispose 不回收、
		// 可弹窗轰炸）。合法 URL 转为受管体系内的新 tab；非法协议直接拒绝。
		view.webContents.setWindowOpenHandler(({ url }) => {
			try {
				normalizeNavigationUrl(url);
			} catch {
				return { action: "deny" };
			}
			void this.openTab(state.handle, `popup-${state.nextTabId++}`, { url }).catch(() => {});
			return { action: "deny" };
		});

		const cdp = new BrowserCdp(view.webContents);
		cdp.attach();
		const tab: TabRecord = { view, cdp, generation: 0 };
		this.installTabListeners(state, tabName, tab);
		state.tabs.set(tabName, tab);
		return tab;
	}

	private installTabListeners(state: BrowserState, tabName: string, tab: TabRecord): void {
		const contents = tab.view.webContents;

		// 导航前 URL 校验（协议白名单）；校验失败阻止导航。
		contents.on("will-navigate", (event, url) => {
			try {
				normalizeNavigationUrl(url);
			} catch {
				event.preventDefault();
			}
		});

		// 服务端重定向（含 http→https 同站跳转）也走同一套白名单：
		// 合法 http/https/about 放行，非法协议（file:/javascript: 等）阻止。
		contents.on("will-redirect", (event, url) => {
			try {
				normalizeNavigationUrl(url);
			} catch {
				event.preventDefault();
			}
		});

		// 导航/重渲染开始 → 观察代际失效。
		contents.on("did-start-loading", () => {
			const tab = state.tabs.get(tabName);
			if (tab) tab.generation++;
		});
		contents.on("did-navigate", () => this.notifyActivity());
		contents.on("did-navigate-in-page", () => this.notifyActivity());
		contents.on("page-title-updated", () => this.notifyActivity());

		// tab 被销毁（close/崩溃）→ 按记录身份清理：webContents.close() 是异步的，
		// destroyed 事件可能在同名 tab 已重建后才到达，必须校验 map 中的记录仍是
		// 本记录才清理（否则会误删重建的新 tab，造成孤儿视图）。
		contents.on("destroyed", () => {
			const wasActive = this.activeHandle === state.handle && this.activeTab === tabName;
			this.removeTabRecord(state, tabName, tab);
			if (wasActive) {
				const next = state.tabs.keys().next().value as string | undefined;
				this.activeTab = next ?? null;
				this.activityListener?.();
			}
		});
	}

	/**
	 * 按记录身份从会话移除 tab（幂等）：仅当 map 中仍是该记录时才清理，
	 * 防止过期 destroyed 事件或重复关闭误删重建的同名 tab。
	 */
	private removeTabRecord(state: BrowserState, tabName: string, tab: TabRecord): void {
		if (state.tabs.get(tabName) !== tab) return;
		state.tabs.delete(tabName);
		try {
			this.owner?.contentView.removeChildView(tab.view);
		} catch {
			// owner 已销毁
		}
		if (this.presentation?.handle === state.handle && this.presentation.tab === tabName) {
			this.presentation = null;
		}
	}

	/** 触发活动推送（去抖由 IPC 层负责）。 */
	private notifyActivity(): void {
		this.activityListener?.();
	}

	// ============================================================
	// 导航 / 页面执行
	// ============================================================

	private async loadUrl(
		tab: TabRecord,
		url: string,
		signal?: AbortSignal,
		waitUntil: WaitUntil = "domcontentloaded",
	): Promise<void> {
		throwIfBrowserOperationAborted(signal);
		const contents = tab.view.webContents;
		const navigate = () =>
			withBrowserCdpTimeout(
				() => contents.loadURL(url),
				"Page.navigate",
				BROWSER_OBSERVE_TIMEOUT_MS + 3_000,
				signal,
			);
		if (waitUntil === "domcontentloaded") {
			// dom-ready 在 did-finish-load（loadURL resolve）之前触发：先挂监听再导航。
			// loadURL 抛错（导航失败）时 dom-ready 不会触发，由超时护栏兜底。
			let resolveReady: () => void = () => {};
			const domReady = new Promise<void>((resolve) => {
				resolveReady = resolve;
			});
			contents.on("dom-ready", resolveReady);
			try {
				await navigate();
				await withBrowserCdpTimeout(
					() => domReady,
					"Page.domContentEventFired",
					BROWSER_OBSERVE_TIMEOUT_MS,
					signal,
				);
			} finally {
				// 导航抛错/超时/abort 时必须摘掉监听器，避免永驻泄漏。
				contents.off("dom-ready", resolveReady);
			}
			return;
		}
		// "load" / networkidle0 / networkidle2：loadURL resolve 于 did-finish-load，
		// networkidle 语义近似（Electron 无直接事件，等加载完成即可）。
		await navigate();
	}

	/** 在页面上下文执行脚本（带超时；导航中上下文销毁时抛错，由调用方决定是否吞掉）。 */
	private async evalInTab(tab: TabRecord, code: string, signal?: AbortSignal): Promise<unknown> {
		throwIfBrowserOperationAborted(signal);
		return withBrowserCdpTimeout(
			() => tab.view.webContents.executeJavaScript(code, true),
			"Runtime.evaluate",
			BROWSER_OBSERVE_TIMEOUT_MS,
			signal,
		);
	}

	// ============================================================
	// Agent 自动化（BrowserHost）
	// ============================================================

	/** 观察页面：序列化 DOM 树 + 元素索引 + 页面统计（页面脚本不变）。 */
	async observe(handle: string, tabName: string, signal?: AbortSignal): Promise<BrowserObservation> {
		this.touchActive(handle, tabName);
		const tab = this.getTab(handle, tabName);
		const result = (await this.evalInTab(tab, buildDomSnapshotScript(), signal)) as {
			title?: string;
			url?: string;
			tree?: string;
			elements?: BrowserObservation["elements"];
			pageStats?: BrowserObservation["pageStats"];
			pageInfo?: BrowserObservation["pageInfo"];
		};
		tab.generation++;
		return {
			generation: tab.generation,
			title: result.title ?? "",
			url: result.url ?? tab.view.webContents.getURL(),
			tree: result.tree ?? "",
			elements: result.elements ?? [],
			pageStats: result.pageStats ?? {
				links: 0,
				interactive: 0,
				iframes: 0,
				shadowOpen: 0,
				images: 0,
				total: 0,
			},
			pageInfo: result.pageInfo ?? { pagesAbove: 0, pagesBelow: 0, viewportHeight: 720 },
		};
	}

	async screenshot(
		handle: string,
		tabName: string,
		fullPage = false,
		signal?: AbortSignal,
	): Promise<BrowserScreenshot> {
		this.touchActive(handle, tabName);
		const tab = this.getTab(handle, tabName);

		// fullPage：用 CDP 渲染管线截图（captureBeyondViewport 覆盖整页）。
		// 注意 CDP Page.captureScreenshot 在视图隐藏时可能挂起，仅窗口可见时使用，
		// 否则降级为视口截图（capturePage），避免长时间卡死。
		if (fullPage && this.owner?.isVisible()) {
			try {
				const shot = await tab.cdp.send(
					"Page.captureScreenshot",
					{ format: "png", captureBeyondViewport: true, fromSurface: true },
					BROWSER_OBSERVE_TIMEOUT_MS + 5_000,
					signal,
				);
				const data = shot.data as string | undefined;
				if (typeof data === "string" && data.length > 0) {
					const png = Buffer.from(data, "base64");
					const size = pngSizeFromHeader(png);
					return { data, mimeType: "image/png", ...size };
				}
			} catch (error) {
				// CDP 全页截图失败（罕见）：降级为视口截图
				console.warn("[受管浏览器] fullPage CDP 截图失败，降级为视口截图:", error);
			}
		}

		let image: NativeImage;
		try {
			// capturePage 依赖主窗口可见（与视图可见性无关）；隐藏的视图仍可截图。
			image = await withBrowserCdpTimeout(
				() => tab.view.webContents.capturePage(),
				"Page.captureScreenshot",
				BROWSER_OBSERVE_TIMEOUT_MS + 3_000,
				signal,
			);
		} catch (error) {
			if (error instanceof Error && /display surface|not available/i.test(error.message)) {
				throw new Error("无法截取页面：Look 窗口当前不可见（可能被最小化）。请保持窗口可见后重试。");
			}
			throw error;
		}
		if (image.isEmpty()) {
			throw new Error("截图为空：页面尚未完成可捕获布局，请稍后重试或改用 browser_snapshot。");
		}
		const { width, height } = image.getSize();
		return {
			data: image.toPNG().toString("base64"),
			mimeType: "image/png",
			width,
			height,
		};
	}

	/** 点击快照中的元素（CDP 真实鼠标事件；index 来自 observe 的 [index]）。 */
	async click(handle: string, tabName: string, index: number, signal?: AbortSignal): Promise<void> {
		this.touchActive(handle, tabName);
		const tab = this.getTab(handle, tabName);
		const { x, y } = await this.resolveRefCenter(tab, index, signal);
		await tab.cdp.send(
			"Input.dispatchMouseEvent",
			{ type: "mousePressed", x, y, button: "left", clickCount: 1 },
			undefined,
			signal,
		);
		await tab.cdp.send(
			"Input.dispatchMouseEvent",
			{ type: "mouseReleased", x, y, button: "left", clickCount: 1 },
			undefined,
			signal,
		);
	}

	/** 在快照元素中整段填写文本（聚焦 → 全选 → 真实输入，兼容受控组件）。 */
	async fill(handle: string, tabName: string, index: number, text: string, signal?: AbortSignal): Promise<void> {
		if (text.length > 10_000) throw new Error("单次输入不能超过 10000 个字符。");
		this.touchActive(handle, tabName);
		const tab = this.getTab(handle, tabName);
		await this.resolveRefCenter(tab, index, signal);
		const selector = `[${LOOK_REF_ATTRIBUTE}="${index}"]`;
		await this.evalInTab(
			tab,
			`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus({ preventScroll: true }); return true; })()`,
			signal,
		);
		const modifier = process.platform === "darwin" ? 4 : 2;
		await tab.cdp.send(
			"Input.dispatchKeyEvent",
			{ type: "keyDown", key: "a", code: "KeyA", modifiers: modifier },
			undefined,
			signal,
		);
		await tab.cdp.send(
			"Input.dispatchKeyEvent",
			{ type: "keyUp", key: "a", code: "KeyA", modifiers: modifier },
			undefined,
			signal,
		);
		await tab.cdp.send("Input.insertText", { text }, undefined, signal);
	}

	/** 按下导航键（Enter/Tab/Escape/方向键等）或向聚焦元素输入文本。 */
	async press(handle: string, tabName: string, key: string, signal?: AbortSignal): Promise<void> {
		if (!key) throw new Error("press 需要按键或文本。");
		this.touchActive(handle, tabName);
		const tab = this.getTab(handle, tabName);
		const mapped = NAV_KEY_MAP[key];
		if (mapped) {
			const keyEvent = { key, code: mapped.code, windowsVirtualKeyCode: mapped.windowsVirtualKeyCode };
			await tab.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...keyEvent }, undefined, signal);
			await tab.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...keyEvent }, undefined, signal);
		} else {
			// 其余按完整文本插入到聚焦元素（支持空格/标点/Unicode/换行）。
			if (key.length > 10_000) throw new Error("单次输入不能超过 10000 个字符。");
			await tab.cdp.send("Input.insertText", { text: key }, undefined, signal);
		}
	}

	/** 滚动页面或指定元素。 */
	async scroll(
		handle: string,
		tabName: string,
		direction: BrowserScrollDirection,
		pages = 1,
		index?: number,
		signal?: AbortSignal,
	): Promise<void> {
		this.touchActive(handle, tabName);
		const tab = this.getTab(handle, tabName);
		if (index !== undefined) {
			const dir = direction === "down" ? 1 : -1;
			const selector = `[${LOOK_REF_ATTRIBUTE}="${index}"]`;
			await this.evalInTab(
				tab,
				`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollBy({ top: ${dir} * el.clientHeight, behavior: "smooth" }); return true; })()`,
				signal,
			);
			return;
		}
		const height = tab.lastBounds?.height ?? 720;
		const deltaY = direction === "down" ? pages * height : -pages * height;
		await tab.cdp.send(
			"Input.dispatchMouseEvent",
			{
				type: "mouseWheel",
				x: Math.round((tab.lastBounds?.width ?? 1280) / 2),
				y: Math.round(height / 2),
				deltaX: 0,
				deltaY,
			},
			undefined,
			signal,
		);
	}

	/** 等待页面满足条件（URL 片段/可见文本/CSS selector），不执行模型 JS。 */
	async waitFor(
		handle: string,
		tabName: string,
		condition: BrowserWaitCondition,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<boolean> {
		if (!condition.value.trim()) throw new Error("等待条件不能为空。");
		if (!Number.isFinite(timeoutMs) || timeoutMs < 250) throw new Error("等待超时不能小于 250ms。");
		throwIfBrowserOperationAborted(signal);
		this.touchActive(handle, tabName);
		const tab = this.getTab(handle, tabName);
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
			throwIfBrowserOperationAborted(signal);
			// 导航会销毁页面执行上下文（"Execution context was destroyed"），
			// 这恰是等待 URL 变化时的常态——吞掉继续轮询，直到超时或新上下文命中条件。
			// abort 错误不属于此类：必须重新抛出终止等待。
			let result = false;
			try {
				result = (await this.evalInTab(tab, expression, signal)) === true;
			} catch (error) {
				if (error instanceof BrowserOperationAbortedError || signal?.aborted) throw error;
				// context destroyed mid-navigation — keep polling
			}
			if (result === true) return true;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		return false;
	}

	/**
	 * 在 tab 中执行模型提供的 JS 代码（高级兜底）。
	 *
	 * 页面脚本通过 executeJavaScript 求值，页面内收集 `display()` 输出。
	 * 页面内 `tab.screenshot()` 不受支持（WebContentsView 无 puppeteer
	 * exposeFunction），调用会抛错并走下方的错误路径——模型应改用
	 * browser_screenshot 工具。
	 *
	 * 出错时返回的结果带 `error` 字段（扩展层据此标记 isError），错误详情
	 * 文本仍保留在 displays 中供展示。
	 *
	 * @param timeoutMs 超时毫秒；超出后拒绝（页面内死循环无法被 CDP 强杀，
	 *   但主进程不再等待，并主动关掉该 tab 让下一次操作重建）。
	 */
	async run(
		handle: string,
		tabName: string,
		code: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<BrowserRunResult> {
		this.touchActive(handle, tabName);
		const tab = this.getTab(handle, tabName);

		const script = buildRunPageScript(code, buildDomSnapshotFunction());
		const displays: DisplayItem[] = [];

		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = (await Promise.race([
				withBrowserCdpTimeout(
					() => tab.view.webContents.executeJavaScript(script, true),
					"Runtime.evaluate",
					timeoutMs + 3_000,
					signal,
				),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						// 哨兵标记：页面脚本抛出的普通错误若消息恰含 "timed out"
						// 不应误触发下面的杀 tab 逻辑。
						const err = new Error(`Browser run timed out after ${timeoutMs}ms`);
						(err as Error & { lookRunTimeout?: boolean }).lookRunTimeout = true;
						reject(err);
					}, timeoutMs);
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

			return { displays, returnValue: result.returnValue };
		} catch (error) {
			if (timer) clearTimeout(timer);
			const message = error instanceof Error ? error.message : String(error);
			displays.push({
				type: "text",
				text: `Browser run error: ${message}`,
			});
			// 超时可能是页面内同步死循环卡死了 JS 线程；主动关掉该 tab，让下一次操作重建。
			if (error instanceof Error && (error as Error & { lookRunTimeout?: boolean }).lookRunTimeout) {
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
			return { displays, error: message };
		}
	}

	isHeadless(handle: string): boolean {
		// WebContentsView 方案下视图始终存在（可被面板显示），无真正 headless。
		return this.browsers.get(handle)?.headless ?? false;
	}

	// ============================================================
	// 内置浏览器面板 API
	// ============================================================

	/** 面板状态快照（无浏览器/无活动 tab 时返回空状态）。 */
	async getPanelState(): Promise<BrowserPanelState> {
		const target = this.getActiveTarget();
		if (!target) return { running: false, headless: false, tabs: [] };
		const state = this.browsers.get(target.handle);
		if (!state) return { running: false, headless: false, tabs: [] };
		const tabs: BrowserPanelTabInfo[] = [];
		for (const [name, tab] of state.tabs) {
			const wc = tab.view.webContents;
			if (wc.isDestroyed()) continue;
			const bounds = tab.lastBounds;
			tabs.push({
				name,
				url: wc.getURL(),
				title: wc.getTitle() || "",
				active: name === target.tab,
				viewport: bounds ? { width: bounds.width, height: bounds.height } : { width: 1280, height: 720 },
			});
		}
		const active = state.tabs.get(target.tab);
		const activeWc = active && !active.view.webContents.isDestroyed() ? active.view.webContents : null;
		const bounds = active?.lastBounds;
		return {
			running: true,
			headless: state.headless,
			handle: target.handle,
			tabs,
			activeTab: target.tab,
			url: activeWc ? activeWc.getURL() : undefined,
			title: activeWc ? activeWc.getTitle() || undefined : undefined,
			viewport: bounds ? { width: bounds.width, height: bounds.height } : undefined,
		};
	}

	/**
	 * 布局桥接：renderer 的 BrowserSlot 上报占位 div 的位置，这里同步
	 * 对应 WebContentsView 的边界与可见性。revision 全局单调递增，
	 * 只采纳每个会话最新布局，且晚到的旧 show 不能抢回前台。
	 */
	setLayout(layout: BrowserViewLayout): void {
		const state = this.browsers.get(layout.handle);
		if (!state) return;
		if (!Number.isSafeInteger(layout.revision) || layout.revision <= state.lastLayoutRevision) return;
		state.lastLayoutRevision = layout.revision;
		const tab = state.tabs.get(layout.tab);
		if (!tab) return;

		const bounds = layout.bounds;
		const visible =
			layout.visible &&
			bounds.width > 4 &&
			bounds.height > 4 &&
			!!this.owner &&
			!this.owner.isDestroyed() &&
			this.owner.isVisible();

		if (!visible) {
			tab.view.setVisible(false);
			// 区分两种隐藏：
			// - 渲染端主动隐藏（layout.visible === false：关面板/切 tab/浮层遮挡）——
			//   清掉前台归属，窗口 focus/show/restore 的 replayPresentation 不应复活
			//   用户主动隐藏的视图；
			// - 窗口最小化/隐藏导致的被动隐藏（visible 为 true 但窗口不可见）——
			//   保留 presentation（前台归属）供窗口恢复时重放，否则 renderer 去抖
			//   不会重发布局，视图会一直隐藏（见 setOwnerWindow）。
			if (!layout.visible && this.presentation?.handle === layout.handle && this.presentation.tab === layout.tab) {
				this.presentation = null;
			}
			return;
		}

		// revision 在 renderer 全局单调递增。A 的旧 show 即使在 B 已显示后晚到，
		// 也不能重新把 A 的原生 view 放到前台。
		if (layout.revision <= this.latestPresentationRevision) return;

		const zoomFactor = this.owner?.webContents.getZoomFactor() ?? 1;
		const adjustedBounds = {
			x: Math.round(bounds.x * zoomFactor),
			y: Math.round(bounds.y * zoomFactor),
			width: Math.round(bounds.width * zoomFactor),
			height: Math.round(bounds.height * zoomFactor),
		};
		this.hideAllViewsExcept(layout.handle, layout.tab);
		if (
			!tab.lastBounds ||
			Object.entries(adjustedBounds).some(
				([key, value]) => tab.lastBounds?.[key as keyof typeof adjustedBounds] !== value,
			)
		) {
			tab.view.setBounds(adjustedBounds);
			tab.lastBounds = { ...adjustedBounds };
		}
		tab.view.setVisible(true);
		this.presentation = { handle: layout.handle, tab: layout.tab, revision: layout.revision };
		this.latestPresentationRevision = layout.revision;
	}

	/** 隐藏所有其他原生视图（跨会话单前台）。 */
	private hideAllViewsExcept(targetHandle: string, targetTab: string): void {
		for (const state of this.browsers.values()) {
			for (const [name, tab] of state.tabs) {
				if (state.handle === targetHandle && name === targetTab) continue;
				tab.view.setVisible(false);
			}
		}
	}

	/** 执行面板交互动作（原生视图下用户直接交互页面，无需坐标映射）。 */
	async panelAction(action: BrowserPanelAction): Promise<void> {
		const target = this.getActiveTarget();
		if (!target) throw new Error("浏览器未启动或没有可交互的 tab。请先让 Agent 打开浏览器。");
		const tab = this.getTab(target.handle, target.tab);
		switch (action.kind) {
			case "type":
				if (action.text.length > 10_000) throw new Error("单次输入不能超过 10000 个字符。");
				await tab.cdp.send("Input.insertText", { text: action.text });
				break;
			case "press":
				await this.press(target.handle, target.tab, action.key);
				break;
			case "navigate":
				await this.loadUrl(tab, normalizeNavigationUrl(action.url) ?? "about:blank");
				break;
			case "back":
				tab.view.webContents.navigationHistory.goBack();
				break;
			case "forward":
				tab.view.webContents.navigationHistory.goForward();
				break;
			case "reload":
				tab.view.webContents.reload();
				break;
			case "selectTab":
				this.requireTab(target.handle, action.name);
				this.activeTab = action.name;
				this.activityListener?.();
				break;
			case "closeTab":
				await this.closeTab(target.handle, action.name);
				break;
			case "newTab": {
				const state = this.browsers.get(target.handle);
				if (!state) throw new Error("浏览器实例不存在。");
				// 递增计数器命名：pages.size 在关闭 tab 后会回退，可能撞上已存在的名字，
				// openTab 撞名会静默复用旧 tab 并把它导航走。
				const name = `tab-${state.nextTabId++}`;
				await this.openTab(target.handle, name, action.url ? { url: action.url } : undefined);
				break;
			}
		}
	}

	// ============================================================
	// 内部工具
	// ============================================================

	/** 校验 tab 存在（不存在抛错）。 */
	private requireTab(handle: string, tabName: string): void {
		const state = this.browsers.get(handle);
		const tab = state?.tabs.get(tabName);
		if (!tab || tab.view.webContents.isDestroyed()) {
			throw new Error(`Tab "${tabName}" 不存在。`);
		}
	}

	/**
	 * 通过快照 index 定位元素中心点（页面内 getBoundingClientRect）。
	 * 元素必须带 data-look-ref 标记——导航/重渲染后标记消失，报错要求重新 observe。
	 */
	private async resolveRefCenter(
		tab: TabRecord,
		index: number,
		signal?: AbortSignal,
	): Promise<{ x: number; y: number }> {
		if (!Number.isInteger(index) || index < 1)
			throw new Error("元素 index 必须是大于 0 的整数（来自 browser_snapshot 的 [index]）。");
		const selector = `[${LOOK_REF_ATTRIBUTE}="${index}"]`;
		const result = (await this.evalInTab(
			tab,
			`(() => {
				const el = document.querySelector(${JSON.stringify(selector)});
				if (!el) return null;
				el.scrollIntoView({ block: "center", inline: "nearest" });
				const r = el.getBoundingClientRect();
				return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
			})()`,
			signal,
		)) as { x?: number; y?: number } | null;
		if (!result || typeof result.x !== "number" || typeof result.y !== "number") {
			throw new Error(
				`元素 [${index}] 不存在或已失效（页面可能已导航/重渲染）。请先重新调用 browser_snapshot 获取最新 index。`,
			);
		}
		return { x: result.x, y: result.y };
	}

	/** 会话 partition 的 Electron Session 网络 guard（权限全拒，只注册一次）。 */
	private installSessionGuards(browserSession: Session): void {
		if (this.guardedSessions.has(browserSession)) return;
		this.guardedSessions.add(browserSession);
		browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
	}

	private getState(handle: string): BrowserState {
		const state = this.browsers.get(handle);
		if (!state) throw new Error(`Browser handle "${handle}" not found. Open a browser first.`);
		return state;
	}

	private getTab(handle: string, tabName: string): TabRecord {
		const state = this.getState(handle);
		const tab = state.tabs.get(tabName);
		if (!tab || tab.view.webContents.isDestroyed()) {
			throw new Error(`Tab "${tabName}" not found. Open it first with browser_open.`);
		}
		return tab;
	}

	private async pageInfo(tab: TabRecord): Promise<PageInfo> {
		const bounds = tab.lastBounds;
		return {
			title: tab.view.webContents.getTitle(),
			url: tab.view.webContents.getURL(),
			viewport: bounds ? { width: bounds.width, height: bounds.height } : { width: 1280, height: 720 },
		};
	}
}

/**
 * 从 PNG 二进制头解析尺寸（IHDR chunk）。CDP Page.captureScreenshot 不返回
 * 尺寸信息，而 BrowserScreenshot 契约需要 width/height。
 * 布局：8 字节签名 + IHDR chunk（4 字节长度 + 4 字节类型 + 4 字节宽 + 4 字节高）。
 */
function pngSizeFromHeader(png: Buffer): { width: number; height: number } {
	if (png.length >= 24 && png.readUInt32BE(12) === 0x49484452 /* "IHDR" */) {
		return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
	}
	return { width: 0, height: 0 };
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
			screenshot: async () => {
				throw new Error("tab.screenshot() is not supported in browser_run; use the browser_screenshot tool instead.");
			},
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
