// ============================================================
// Browser router — 内置浏览器面板的查询与交互
//
// 面板展示 agent 正在操作的浏览器（活动 handle/tab 由
// BrowserService 在每次工具调用时更新）：
//   - browser:get-state      面板状态（tabs / url / title / viewport）
//   - browser:panel-action   用户交互（输入/导航/前进后退/切 tab 等）
//
// agent 使用浏览器工具时，BrowserService 触发 activity 回调，本路由
// 将其转发为 `browser:activity` 事件——renderer 据此（在设置开启时）
// 自动滑出面板。
// ============================================================

import type { BrowserViewLayout } from "@look/shared";
import type { BrowserWindow } from "electron";
import type { BrowserService } from "../../browser/browser-service.js";
import type { BrowserPanelAction } from "../../browser/types.js";
import { guardNumber, guardOptionalString, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

/** 已绑定 activity 推送的主窗口（窗口重建后重新绑定，避免闭包持有已销毁窗口）。 */
let activityBoundTo: BrowserWindow | null = null;

/** activity 推送去抖间隔：agent 一轮 observe/click 循环会连发多次触碰。 */
const ACTIVITY_DEBOUNCE_MS = 300;

let activityPushTimer: ReturnType<typeof setTimeout> | null = null;

/** 把 BrowserService 的 activity 回调转发为 renderer 事件（幂等，按窗口实例去重 + 去抖）。 */
function ensureActivityPush(service: BrowserService, win: BrowserWindow): void {
	if (activityBoundTo === win) return;
	activityBoundTo = win;
	service.onPanelActivity(() => {
		// 去抖合并连发的触碰事件；触发时再校验窗口存活。
		if (activityPushTimer) return;
		activityPushTimer = setTimeout(() => {
			activityPushTimer = null;
			if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
			win.webContents.send("look:event", { type: "browser:activity" });
		}, ACTIVITY_DEBOUNCE_MS);
	});
}

/** 解析 browser:panel-action 载荷为类型化 action（测试导出）。 */
export function parseAction(data: Record<string, unknown>, kind: string): BrowserPanelAction {
	switch (kind) {
		case "type":
			return { kind, text: guardString(data.text, "text") };
		case "press":
			return { kind, key: guardString(data.key, "key") };
		case "navigate":
			return { kind, url: guardString(data.url, "url") };
		case "selectTab":
		case "closeTab":
			return { kind, name: guardString(data.name, "name") };
		case "newTab":
			return { kind, url: guardOptionalString(data.url, "url") };
		case "back":
		case "forward":
		case "reload":
			return { kind };
		default:
			throw new Error(`Unsupported browser panel action: ${String(kind)}`);
	}
}

/**
 * 启动时即绑定 activity 推送——agent 使用浏览器工具时 renderer 可以自动
 * 打开面板，无需面板先被打开过一次（懒注册会让自动打开永远失效）。
 * 同时把主窗口注入 BrowserService（WebContentsView 的挂载目标）。
 */
export function bindBrowserActivityToWindow(service: BrowserService, win: BrowserWindow): void {
	service.setOwnerWindow(win);
	ensureActivityPush(service, win);
}

/** 校验 browser:set-layout 载荷形状（renderer 输入不可信，测试导出）。 */
export function parseLayout(data: Record<string, unknown>): BrowserViewLayout {
	const layout = data.layout;
	if (!layout || typeof layout !== "object") throw new Error("browser:set-layout 缺少 layout。");
	const record = layout as Record<string, unknown>;
	const bounds = record.bounds;
	if (!bounds || typeof bounds !== "object") throw new Error("browser:set-layout 缺少 bounds。");
	const b = bounds as Record<string, unknown>;
	return {
		handle: guardString(record.handle, "layout.handle"),
		tab: guardString(record.tab, "layout.tab"),
		revision: guardNumber(record.revision, "layout.revision"),
		visible: record.visible === true,
		bounds: {
			x: guardNumber(b.x, "layout.bounds.x"),
			y: guardNumber(b.y, "layout.bounds.y"),
			width: guardNumber(b.width, "layout.bounds.width"),
			height: guardNumber(b.height, "layout.bounds.height"),
		},
	};
}

export const browserRouter: IpcRouter = (ctx, register) => {
	register("browser:get-state", async () => {
		ensureActivityPush(ctx.browser.service, ctx.mainWindow);
		return { success: true, state: await ctx.browser.service.getPanelState() };
	});

	// renderer BrowserSlot 布局上报 → 原生 WebContentsView setBounds/setVisible。
	// 高频通道：不返回错误（错误仅日志），晚到旧 revision 由主进程忽略。
	register("browser:set-layout", (data) => {
		ensureActivityPush(ctx.browser.service, ctx.mainWindow);
		try {
			ctx.browser.service.setLayout(parseLayout(data));
		} catch (err) {
			console.warn("[受管浏览器] 忽略非法布局上报:", err instanceof Error ? err.message : err);
		}
		return { success: true };
	});

	register("browser:panel-action", async (data) => {
		const kind = guardString(data.kind, "kind");
		const action = parseAction(data, kind);
		try {
			await ctx.browser.service.panelAction(action);
			return { success: true };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	// 手动开关面板时同步 activity 推送绑定（无浏览器也可打开空面板引导）。
	register("browser:open-panel", async (data) => {
		ensureActivityPush(ctx.browser.service, ctx.mainWindow);
		const force = typeof data.force === "boolean" ? data.force : false;
		if (force && ctx.browser.service.getActiveTarget() === null) {
			// 用户在空状态下点击“打开浏览器”：启动一个空白页作为交互目标。
			// service 内部串行化（双击只启动一个），失败时回收刚 launch 的实例。
			try {
				await ctx.browser.service.launchForPanelIfIdle();
			} catch (err) {
				return {
					success: false,
					error: `无法启动浏览器：${err instanceof Error ? err.message : String(err)}`,
				};
			}
		}
		return { success: true };
	});

	// 面板关闭：回收面板自启（非 agent 扩展持有）的浏览器实例，避免 Chromium
	// 进程挂到应用退出；agent 的实例由 session_shutdown 负责，不受影响。
	register("browser:close-panel", async () => {
		// activity 监听保留（agent 仍可能继续用浏览器，下次活动会重新拉起面板）。
		try {
			await ctx.browser.service.disposePanelBrowsers();
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
		return { success: true };
	});
};
