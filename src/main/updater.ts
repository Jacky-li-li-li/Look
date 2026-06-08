// ============================================================
// Updater — electron-updater wrapper
// Forwards autoUpdater events to renderer via IPC.
//
// electron-updater is loaded lazily so a missing/optional dep never
// blocks app start. If the module isn't installed we emit one
// `update:error` event and degrade silently thereafter.
// ============================================================

import { BrowserWindow } from "electron";
import type { AppUpdater } from "electron-updater";

let autoUpdater: AppUpdater | null = null;
let loadFailed = false;

async function loadAutoUpdater(): Promise<AppUpdater | null> {
	if (autoUpdater) return autoUpdater;
	if (loadFailed) return null;
	try {
		const mod = await import("electron-updater");
		autoUpdater = mod.autoUpdater;
		return autoUpdater;
	} catch (err) {
		loadFailed = true;
		console.warn(`[updater] electron-updater not available: ${(err as Error).message}`);
		return null;
	}
}

export function initUpdater(mainWindow: BrowserWindow): void {
	if (!mainWindow || mainWindow.isDestroyed()) return;

	// Lazy-load on first event so a missing/optional dep never crashes app start.
	void loadAutoUpdater().then((updater) => {
		if (!updater) {
			emit(mainWindow, {
				type: "update:error",
				message: "electron-updater module not available. Run `npm install electron-updater`.",
			});
			return;
		}

		updater.autoDownload = false;
		updater.autoInstallOnAppQuit = true;

		updater.on("checking-for-update", () => {
			emit(mainWindow, { type: "update:checking" });
		});

		updater.on("update-available", (info) => {
			emit(mainWindow, {
				type: "update:available",
				version: info.version,
				releaseDate: (info as any).releaseDate,
			});
		});

		updater.on("update-not-available", () => {
			emit(mainWindow, { type: "update:not-available" });
		});

		updater.on("download-progress", (progress) => {
			emit(mainWindow, {
				type: "update:download-progress",
				percent: progress.percent,
			});
		});

		updater.on("update-downloaded", (info) => {
			emit(mainWindow, {
				type: "update:downloaded",
				version: info.version,
			});
		});

		updater.on("error", (error) => {
			emit(mainWindow, {
				type: "update:error",
				message: error.message ?? "Unknown update error",
			});
		});
	});
}

function emit(mainWindow: BrowserWindow, event: Record<string, unknown>): void {
	if (!mainWindow.isDestroyed()) {
		mainWindow.webContents.send("look:event", event);
	}
}

export async function checkForUpdates(): Promise<void> {
	const updater = await loadAutoUpdater();
	if (!updater) throw new Error("electron-updater not installed");
	await updater.checkForUpdates();
}

export async function downloadUpdate(): Promise<void> {
	const updater = await loadAutoUpdater();
	if (!updater) throw new Error("electron-updater not installed");
	await updater.downloadUpdate();
}

export function quitAndInstall(): void {
	if (!autoUpdater) {
		console.warn("[updater] quitAndInstall called before updater was loaded");
		return;
	}
	autoUpdater.quitAndInstall();
}
