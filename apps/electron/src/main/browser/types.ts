// ============================================================
// Browser — 共享类型（无 Electron / puppeteer 依赖）
//
// 扩展（extensions/browser-extension.ts）与浏览器服务
// （browser/browser-service.ts）都依赖这里，保证扩展侧及其
// 单测不需要加载 Electron 或原生模块。
// ============================================================

/** 观察到的页面元素（对应快照中的 [index] 编号）。 */
export interface ObservedElement {
	/** 快照内全局递增编号（从 1 开始），用于 tab.click(index) 等交互。 */
	index: number;
	/** ARIA role，如 "button"、"link"、"textbox"。 */
	role: string;
	/** 可访问名称（按钮文本、链接文字等）。 */
	name: string;
	/** 元素标签名（小写），如 "button"、"input"。 */
	tag: string;
	/** 关键属性摘要（placeholder/value/maxlength/pattern 等）。 */
	attrs: string;
}

/** 页面统计（引导模型判断页面是否加载完成、是否有更多内容）。 */
export interface BrowserPageStats {
	links: number;
	interactive: number;
	iframes: number;
	shadowOpen: number;
	shadowClosed: number;
	images: number;
	total: number;
}

/** 滚动信息：告诉模型视口上下还有多少内容。 */
export interface BrowserPageInfo {
	pagesAbove: number;
	pagesBelow: number;
	viewportHeight: number;
}

/** 页面观察结果（browser_snapshot 的返回）。 */
export interface BrowserObservation {
	/** 观察代际：导航/重渲染后递增，交互前应重新观察。 */
	generation: number;
	/** 页面标题。 */
	title: string;
	/** 页面 URL。 */
	url: string;
	/** 模型可读的序列化 DOM 树文本（带 [index] 编号）。 */
	tree: string;
	/** 扁平的元素索引表。 */
	elements: ObservedElement[];
	/** 页面统计。 */
	pageStats: BrowserPageStats;
	/** 滚动信息。 */
	pageInfo: BrowserPageInfo;
}

/** 浏览器截图结果。 */
export interface BrowserScreenshot {
	/** base64 编码的 PNG。 */
	data: string;
	mimeType: "image/png";
	width: number;
	height: number;
	/** 保存到磁盘的路径（可选）。 */
	path?: string;
}

/** 页面基本信息。 */
export interface PageInfo {
	title: string;
	url: string;
	viewport: { width: number; height: number };
}

/** 浏览器运行结果中的展示项。 */
export interface DisplayItem {
	type: "text" | "image";
	text?: string;
	data?: string;
	mimeType?: string;
}

/** 浏览器运行结果。 */
export interface BrowserRunResult {
	/** 模型使用的展示内容。 */
	displays: DisplayItem[];
	/** 代码的返回值。 */
	returnValue?: unknown;
	/** 运行期间捕获的截图。 */
	screenshots?: BrowserScreenshot[];
}

/** 浏览器模式。 */
export type BrowserMode = "headless" | "headed";

/** 启动配置。 */
export interface BrowserLaunchOptions {
	headless?: boolean;
	viewport?: { width: number; height: number };
}

/** 导航等待条件。 */
export type WaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";

/** Tab 打开参数。 */
export interface BrowserOpenOptions {
	url?: string;
	waitUntil?: WaitUntil;
	timeoutMs?: number;
}

/** 等待条件（browser_wait_for 用，页面状态轮询，不执行模型 JS）。 */
export type BrowserWaitCondition =
	| { kind: "url"; value: string }
	| { kind: "text"; value: string }
	| { kind: "selector"; value: string };

/** 滚动方向（browser_scroll 用）。 */
export type BrowserScrollDirection = "up" | "down";

/**
 * 浏览器宿主接口——由主进程 BrowserService 实现。
 * 扩展通过此接口与浏览器层解耦，便于测试。
 */
export interface BrowserHost {
	/** 启动或获取一个浏览器实例。返回唯一句柄。 */
	launch(options?: BrowserLaunchOptions): Promise<string>;
	/** 关闭浏览器实例并清理资源。 */
	dispose(handle: string): Promise<void>;
	/** 打开新 tab 并可选导航。返回 tab 标识。 */
	openTab(handle: string, tabName: string, options?: BrowserOpenOptions): Promise<PageInfo>;
	/** 关闭指定 tab。 */
	closeTab(handle: string, tabName: string): Promise<void>;
	/** 关闭所有 tab。 */
	closeAllTabs(handle: string): Promise<number>;
	/** 观察页面：序列化 DOM 树 + 元素索引 + 页面统计。 */
	observe(handle: string, tabName: string): Promise<BrowserObservation>;
	/** 页面截图。 */
	screenshot(handle: string, tabName: string, fullPage?: boolean): Promise<BrowserScreenshot>;
	/** 点击快照中的元素（真实鼠标事件，index 来自 observe）。 */
	click(handle: string, tabName: string, index: number): Promise<void>;
	/** 在快照元素中整段填写文本（真实键盘事件，清空后输入）。 */
	fill(handle: string, tabName: string, index: number, text: string): Promise<void>;
	/** 按下导航键（Enter/Tab/Escape/方向键等）或向聚焦元素输入文本。 */
	press(handle: string, tabName: string, key: string): Promise<void>;
	/** 滚动页面或指定元素。 */
	scroll(
		handle: string,
		tabName: string,
		direction: BrowserScrollDirection,
		pages?: number,
		index?: number,
	): Promise<void>;
	/** 等待页面满足条件（URL 片段/可见文本/CSS selector）。 */
	waitFor(handle: string, tabName: string, condition: BrowserWaitCondition, timeoutMs: number): Promise<boolean>;
	/** 在 tab 中执行 JS 代码（高级兜底，暴露 page/tab 辅助对象）。 */
	run(handle: string, tabName: string, code: string, timeoutMs: number): Promise<BrowserRunResult>;
	/** 是否为 headless 模式（无窗口）。 */
	isHeadless(handle: string): boolean;
}
