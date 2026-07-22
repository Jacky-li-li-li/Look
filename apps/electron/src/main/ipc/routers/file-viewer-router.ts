// ============================================================
// File viewer window router — 独立查看器窗口的打开与就绪
// ============================================================

import { consumePendingPath, openViewerWindow } from "../../viewer/viewer-window-manager.js";
import { guardPath } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const fileViewerRouter: IpcRouter = (_ctx, register) => {
	register("fileViewer:open", async (data) => {
		const filePath = guardPath(data.path, "path");
		openViewerWindow(filePath);
		return { success: true };
	});

	register("fileViewer:ready", async () => {
		return { success: true, path: consumePendingPath() };
	});
};
