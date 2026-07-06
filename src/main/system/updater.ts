// ============================================================
// Updater — electron-updater wrapper
// Forwards autoUpdater events to renderer via IPC.
//
// electron-updater is loaded lazily so a missing/optional dep never
// blocks app start. If the module isn't installed we emit one
// `update:error` event and degrade silently thereafter.
// ============================================================

import type { BrowserWindow } from "electron";
import type { AppUpdater } from "electron-updater";

let autoUpdater: AppUpdater | null = null;
let loadFailed = false;

async function loadAutoUpdater(): Promise<AppUpdater | null> {
	if (autoUpdater) return autoUpdater;
	if (loadFailed) return null;
	try {
		const mod = await import("electron-updater");
		autoUpdater = resolveAutoUpdater(mod);
		return autoUpdater;
	} catch (err) {
		loadFailed = true;
		const errMsg = (err as Error).message;
		const errStack = (err as Error).stack;
		console.warn(`[updater] electron-updater not available: ${errMsg}`);
		console.warn(`[updater] stack:\n${errStack ?? "(no stack)"}`);
		return null;
	}
}

/**
 * electron-updater exports autoUpdater via Object.defineProperty getter on
 * its CJS exports object. When loaded via ESM import(), that getter is NOT
 * promoted to a named export — mod.autoUpdater is undefined.
 * Access mod.default.autoUpdater (the underlying CJS exports) instead.
 * See: https://github.com/electron-userland/electron-builder/issues/8399
 */
function resolveAutoUpdater(mod: Record<string, unknown>): AppUpdater | null {
	return ((mod.default as Record<string, unknown>)?.autoUpdater as AppUpdater) ?? (mod.autoUpdater as AppUpdater) ?? null;
}

export function initUpdater(mainWindow: BrowserWindow): void {
	if (!mainWindow || mainWindow.isDestroyed()) return;

	// Lazy-load on first event so a missing/optional dep never crashes app start.
	void loadAutoUpdater().then((updater) => {
		if (!updater) {
			emit(mainWindow, {
				type: "update:error",
				message:
					"Updater not available. Check console logs for details, or run `npm install` to ensure all dependencies are present.",
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
				releaseDate: (info as { releaseDate?: string }).releaseDate,
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
