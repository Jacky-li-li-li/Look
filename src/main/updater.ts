// ============================================================
// Updater — electron-updater wrapper
// Forwards autoUpdater events to renderer via IPC
// ============================================================

import { BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";

export function initUpdater(mainWindow: BrowserWindow): void {
	if (!mainWindow || mainWindow.isDestroyed()) return;

	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = true;

	autoUpdater.on("checking-for-update", () => {
		emit(mainWindow, { type: "update:checking" });
	});

	autoUpdater.on("update-available", (info) => {
		emit(mainWindow, {
			type: "update:available",
			version: info.version,
			releaseDate: (info as any).releaseDate,
		});
	});

	autoUpdater.on("update-not-available", () => {
		emit(mainWindow, { type: "update:not-available" });
	});

	autoUpdater.on("download-progress", (progress) => {
		emit(mainWindow, {
			type: "update:download-progress",
			percent: progress.percent,
		});
	});

	autoUpdater.on("update-downloaded", (info) => {
		emit(mainWindow, {
			type: "update:downloaded",
			version: info.version,
		});
	});

	autoUpdater.on("error", (error) => {
		emit(mainWindow, {
			type: "update:error",
			message: error.message ?? "Unknown update error",
		});
	});
}

function emit(mainWindow: BrowserWindow, event: Record<string, unknown>): void {
	if (!mainWindow.isDestroyed()) {
		mainWindow.webContents.send("look:event", event);
	}
}

export async function checkForUpdates(): Promise<void> {
	await autoUpdater.checkForUpdates();
}

export async function downloadUpdate(): Promise<void> {
	await autoUpdater.downloadUpdate();
}

export function quitAndInstall(): void {
	autoUpdater.quitAndInstall();
}
