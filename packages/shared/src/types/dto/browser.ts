// ============================================================
// Browser panel — 内置浏览器面板共享类型（renderer 与 IPC 契约）
// ============================================================

/** 原生视图在窗口中的边界（DIP，CSS 像素）。 */
export interface BrowserViewBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * 浏览器视图布局（renderer → main 的 browser:set-layout 载荷）。
 *
 * renderer 的 BrowserSlot 持续测量占位 div 的 getBoundingClientRect，
 * 主进程据此给对应的 WebContentsView setBounds/setVisible。revision 在
 * renderer 全局单调递增，主进程忽略晚到的旧布局（跨会话/跨窗口竞态）。
 */
export interface BrowserViewLayout {
	/** 主进程浏览器会话 handle（来自 BrowserPanelState.handle）。 */
	handle: string;
	/** 会话内 tab 名。 */
	tab: string;
	/** 布局代际：renderer 每次发布递增（时间戳纪元，见 browser-layout-revision）。 */
	revision: number;
	visible: boolean;
	bounds: BrowserViewBounds;
}

/** 面板中的单个 tab。 */
export interface BrowserPanelTabInfo {
	name: string;
	url: string;
	title: string;
	active: boolean;
	/** 页面视口（逻辑像素，点击映射基准）。 */
	viewport: { width: number; height: number };
}

/** 面板状态快照（browser:get-state 返回）。 */
export interface BrowserPanelState {
	/** 是否有浏览器实例运行。 */
	running: boolean;
	/** headless 与否（面板展示不依赖 headed 窗口）。 */
	headless: boolean;
	/** 全部 tab。 */
	tabs: BrowserPanelTabInfo[];
	/** 当前活动 tab 名。 */
	activeTab?: string;
	/** 当前活动会话 handle（renderer 布局上报用）。 */
	handle?: string;
	/** 当前活动 tab URL。 */
	url?: string;
	/** 当前活动 tab 标题。 */
	title?: string;
	/** 当前活动 tab 视口（点击映射基准）。 */
	viewport?: { width: number; height: number };
}

/** 面板交互动作（browser:panel-action 载荷）。 */
export type BrowserPanelAction =
	| { kind: "type"; text: string }
	| { kind: "press"; key: string }
	| { kind: "navigate"; url: string }
	| { kind: "back" }
	| { kind: "forward" }
	| { kind: "reload" }
	| { kind: "selectTab"; name: string }
	| { kind: "closeTab"; name: string }
	| { kind: "newTab"; url?: string };
