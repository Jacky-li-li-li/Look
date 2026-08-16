// ============================================================
// Browser panel event handler — 主进程 → renderer 的浏览器事件
//
// `browser:activity`：agent 使用浏览器工具 / tab 变化时触发。
// 设置开启「内置浏览器」时自动滑出面板；面板已打开时仅刷新状态。
// 用户手动关闭面板仅关闭当前显示，agent 下一次活动仍会重新滑出
// （彻底不想要自动滑出时，关闭设置里的「内置浏览器」开关即可）。
// ============================================================

import type { BrowserPanelState, MainToRendererEvent } from "@shared/types";
import { appStore } from "./appStore";
import { browserPanelOpenAtom, browserStateAtom } from "./browserAtoms";
import { builtinBrowserEnabledAtom } from "./settingsAtoms";

/** 拉取面板状态快照（对账：弥补订阅前的事件丢失）。 */
export async function refreshBrowserPanelState(): Promise<void> {
	try {
		const result = await window.look.getBrowserPanelState();
		if (result?.success && result.state) {
			appStore.set(browserStateAtom, result.state as BrowserPanelState);
		}
	} catch (err) {
		console.warn("[browserHandlers] getBrowserPanelState failed:", err);
	}
}

/** 处理主进程浏览器事件；返回 true 表示已消费。 */
export function handleBrowserEvent(event: MainToRendererEvent): boolean {
	if (event.type !== "browser:activity") return false;

	const enabled = appStore.get(builtinBrowserEnabledAtom);

	if (enabled) {
		// agent 使用浏览器时自动滑出面板（用户手动关闭仅影响当前显示，
		// 下一次 agent 活动仍会重新滑出；彻底关闭走设置开关）。
		if (!appStore.get(browserPanelOpenAtom)) {
			appStore.set(browserPanelOpenAtom, true);
		}
		void refreshBrowserPanelState();
	}
	return true;
}

/** 用户关闭面板（面板内 X / 顶栏开关）：通知主进程回收面板自启的浏览器。 */
export function dismissBrowserPanel(): void {
	appStore.set(browserPanelOpenAtom, false);
	try {
		void window.look.closeBrowserPanel().catch((err: unknown) => {
			console.warn("[browserHandlers] closeBrowserPanel failed:", err);
		});
	} catch (err) {
		console.warn("[browserHandlers] closeBrowserPanel unavailable:", err);
	}
}

/** 面板开合统一入口（TopSessionBar / 面板内按钮共用）。 */
export function toggleBrowserPanel(): void {
	if (appStore.get(browserPanelOpenAtom)) {
		dismissBrowserPanel();
		return;
	}
	appStore.set(browserPanelOpenAtom, true);
	pokeBrowserPanelRefresh();
}

/** 面板打开后手动刷新（用户操作后立即对账）。 */
export function pokeBrowserPanelRefresh(): void {
	void refreshBrowserPanelState();
}
