// ============================================================
// File viewer window router — 独立查看器窗口的打开与就绪
// ============================================================

import { consumePendingPath, openViewerWindow, resolveViewerDock } from "../../viewer/viewer-window-manager.js";
import { guardPath } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const fileViewerRouter: IpcRouter = (ctx, register) => {
	register("fileViewer:open", async (data) => {
		const filePath = guardPath(data.path, "path");
		openViewerWindow(filePath, { fadeIn: data.fadeIn ?? false, diffPatch: data.diffPatch });
		return { success: true };
	});

	register("fileViewer:ready", async () => {
		const request = consumePendingPath();
		if (!request) return { success: true, path: null };
		return {
			success: true,
			path: request.path,
			...(request.diffPatch !== undefined ? { diffPatch: request.diffPatch } : {}),
		};
	});

	// 独立查看器窗口请求合并到主窗口：聚焦主窗口 → 通知打开右侧 Dock 面板。
	// 本阶段不关闭独立窗口：主窗口渲染端完成脏确认后经 fileViewer:dock-result
	// 回执，confirmed=true 才淡出关闭；用户取消时独立窗口保持打开、文件不丢
	// （此前事件发出即淡出，取消确认会导致文件两端皆失，2026-08-10 修复）。
	// diffPatch 随合并事件带回，主窗口据此恢复与「变更面板打开」一致的 diff 语义。
	register("fileViewer:dock", async (data) => {
		const filePath = guardPath(data.path, "path");
		const mainWindow = ctx.mainWindow;
		// 主窗口不可用(未创建/已销毁)时不发送合并事件——避免用户正在看的文件两端丢失
		if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
			return { success: false, error: "Main window unavailable" };
		}
		mainWindow.show();
		mainWindow.focus();
		mainWindow.webContents.send("look:event", {
			type: "fileViewer:docked",
			path: filePath,
			...(data.diffPatch !== undefined ? { diffPatch: data.diffPatch } : {}),
		});
		return { success: true };
	});

	// 主窗口对合并请求的回执：confirmed 时淡出关闭独立窗口（与 Dock 面板滑入同步）；
	// 取消时保持窗口打开并重新聚焦。
	register("fileViewer:dock-result", async (data) => {
		resolveViewerDock(Boolean(data.confirmed));
		return { success: true };
	});
};
