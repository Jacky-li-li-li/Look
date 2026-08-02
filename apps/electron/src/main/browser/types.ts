// ============================================================
// Browser — 共享类型（无 Electron / puppeteer 依赖）
//
// 扩展（extensions/browser-extension.ts）与浏览器服务
// （browser/browser-service.ts）都依赖这里，保证扩展侧及其
// 单测不需要加载 Electron 或原生模块。
// ============================================================

/** ARIA 可访问性树中的一个元素。 */
export interface AriaElement {
	/** 元素在快照中的序号（从 0 开始），用于后续交互定位。 */
	id: number;
	/** ARIA role，如 "button"、"link"、"textbox"、"heading"。 */
	role: string;
	/** 可访问名称（按钮文本、链接文字等）。 */
	name: string;
	/** 可选描述。 */
	description?: string;
	/** 元素内可见文本（截断前 200 字符）。 */
	text?: string;
	/** 是否 disabled。 */
	disabled?: boolean;
	/** 是否 checked（checkbox/radio）。 */
	checked?: boolean;
	/** 是否可展开（如 details/summary 控件）。 */
	expanded?: boolean;
	/** 层级深度（0 = 根）。 */
	level?: number;
	/** 选中项索引（listbox/select 中）。 */
	selected?: boolean;
	/** 元素内子元素的 id 列表。 */
	children?: number[];
	/** 输入框当前值。 */
	value?: string;
	/** 输入框占位符。 */
	placeholder?: string;
}

/** ARIA 可访问性快照。 */
export interface AriaSnapshot {
	/** 快照生成时间戳。 */
	timestamp: number;
	/** 页面标题。 */
	title: string;
	/** 页面 URL。 */
	url: string;
	/** 扁平的元素数组（按 DOM 顺序），每个元素通过 id 引用子元素。 */
	elements: AriaElement[];
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
	/** ARIA 快照。 */
	snapshot(handle: string, tabName: string): Promise<AriaSnapshot>;
	/** 页面截图。 */
	screenshot(handle: string, tabName: string, fullPage?: boolean): Promise<BrowserScreenshot>;
	/** 在 tab 中执行 JS 代码，暴露 page/tab 辅助对象。 */
	run(handle: string, tabName: string, code: string, timeoutMs: number): Promise<BrowserRunResult>;
	/** 是否为 headless 模式（无窗口）。 */
	isHeadless(handle: string): boolean;
}
