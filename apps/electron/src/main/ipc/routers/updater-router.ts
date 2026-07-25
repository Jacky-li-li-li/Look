// ============================================================
// Updater router — 应用自动更新（检查 / 下载 / 重启安装）
// ============================================================

import { checkForUpdates, downloadUpdate, installUpdate } from "../../system/app-updater.js";
import type { IpcRouter } from "../invoke-context.js";

export const updaterRouter: IpcRouter = (_ctx, register) => {
	register("update:check", async () => checkForUpdates());
	register("update:download", async () => downloadUpdate());
	register("update:install", async () => installUpdate());
};
