// ============================================================
// App Updater — electron-updater 封装
//
// 仅在打包环境启用；更新源为 GitHub Releases（electron-builder.yml 的
// publish provider）。策略：自动检查、手动下载、手动重启安装——
// 渲染层通过 update:status 事件感知状态，通过 update:* IPC 触发动作。
// ============================================================

import type { AppUpdatePhase, MainToRendererEvent } from "@look/shared/types";
import { app } from "electron";
import updater from "electron-updater";

const { autoUpdater } = updater;

const INITIAL_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** 下载完成后自动重启安装的宽限时间（渲染层 toast 同步展示倒计时） */
const AUTO_INSTALL_DELAY_MS = 5_000;

type SendEvent = (event: MainToRendererEvent) => void;

let initialized = false;
let sendEvent: SendEvent | null = null;
let autoInstallTimer: NodeJS.Timeout | null = null;

function emit(phase: AppUpdatePhase, extra?: { version?: string; percent?: number; error?: string }): void {
	console.log(`[Look][updater] ${phase}`, extra ?? "");
	sendEvent?.({ type: "update:status", phase, ...extra });
}

function devError(): { success: false; error: string } {
	return { success: false, error: "开发环境不支持自动更新" };
}

/** 在首个窗口创建后调用。重复调用仅替换事件出口（窗口重建场景）。 */
export function initAppUpdater(send: SendEvent): void {
	if (!app.isPackaged) return;
	if (initialized) {
		sendEvent = send;
		return;
	}
	initialized = true;
	sendEvent = send;

	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = false;

	autoUpdater.on("checking-for-update", () => emit("checking"));
	autoUpdater.on("update-available", (info) => emit("available", { version: info.version }));
	autoUpdater.on("update-not-available", () => emit("not-available"));
	autoUpdater.on("download-progress", (progress) => emit("downloading", { percent: Math.round(progress.percent) }));
	autoUpdater.on("update-downloaded", (info) => {
		emit("downloaded", { version: info.version });
		// 用户点过「下载」即视为同意更新：宽限几秒后自动重启安装，
		// 期间可被 update:cancel-install 取消（退回手动重启）。
		autoInstallTimer = setTimeout(() => {
			autoInstallTimer = null;
			autoUpdater.quitAndInstall();
		}, AUTO_INSTALL_DELAY_MS);
	});
	autoUpdater.on("error", (err) => emit("error", { error: err instanceof Error ? err.message : String(err) }));

	setTimeout(() => {
		void checkForUpdates();
	}, INITIAL_CHECK_DELAY_MS);
	const timer = setInterval(() => {
		void checkForUpdates();
	}, CHECK_INTERVAL_MS);
	timer.unref();
}

export async function checkForUpdates(): Promise<{ success: boolean; error?: string }> {
	if (!app.isPackaged) return devError();
	try {
		await autoUpdater.checkForUpdates();
		return { success: true };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export async function downloadUpdate(): Promise<{ success: boolean; error?: string }> {
	if (!app.isPackaged) return devError();
	try {
		await autoUpdater.downloadUpdate();
		return { success: true };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export async function installUpdate(): Promise<{ success: boolean; error?: string }> {
	if (!app.isPackaged) return devError();
	// 延迟到 IPC 响应送达渲染层后再退出安装
	setImmediate(() => autoUpdater.quitAndInstall());
	return { success: true };
}

/** 取消下载完成后的自动重启安装（退回手动「重启安装」）。 */
export function cancelAutoInstall(): { success: boolean } {
	if (autoInstallTimer) {
		clearTimeout(autoInstallTimer);
		autoInstallTimer = null;
	}
	return { success: true };
}
