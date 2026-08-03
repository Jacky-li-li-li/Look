// ============================================================
// Viewer Window Manager — 独立原生文件查看器窗口
//
// 单例窗口:fileViewer:open 时若已存在则聚焦并转发路径,否则创建新窗口。
// 渲染端以 ?mode=file-viewer 启动纯查看器应用;主题与主窗口一致(读取持久化设置)。
// ============================================================

import path from "node:path";
import { fileURLToPath } from "node:url";
import { getUiSettingsPath } from "@look/shared/look-storage";
import { app, type BrowserWindow, BrowserWindow as ElectronBrowserWindow } from "electron";
import { BrowserWindowEventTransport } from "../ipc/renderer-event-transport.js";
import { readThemeToneSync } from "../settings/store.js";
import { getPackagedRendererIndexPath } from "../system/renderer-paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = (): boolean => !app.isPackaged;

let viewerWindow: BrowserWindow | null = null;
const viewerEvents = new BrowserWindowEventTransport(() => viewerWindow);
/** 窗口已创建但渲染端尚未就绪时暂存的待打开路径,由 fileViewer:ready 一次性消费。 */
let pendingPath: string | null = null;

function sendOpenPath(path: string): void {
	viewerEvents.send({ type: "fileViewer:open-path", path });
}

/** 主窗口入口:在独立查看器窗口中打开指定文件。 */
export function openViewerWindow(absolutePath: string): void {
	if (viewerWindow && !viewerWindow.isDestroyed()) {
		viewerWindow.focus();
		sendOpenPath(absolutePath);
		return;
	}

	pendingPath = absolutePath;
	const tone = readThemeToneSync(getUiSettingsPath());

	viewerWindow = new ElectronBrowserWindow({
		width: 960,
		height: 720,
		minWidth: 480,
		minHeight: 320,
		title: "文件查看器",
		backgroundColor: tone === "light" ? "#fbfbfa" : "#030202",
		icon: path.join(__dirname, "../assets/icon-1024.png"),
		webPreferences: {
			preload: path.join(__dirname, "../preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	viewerWindow.on("closed", () => {
		viewerWindow = null;
	});

	if (isDev()) {
		viewerWindow.loadURL(`http://localhost:5174?theme=${tone}&mode=file-viewer`);
	} else {
		viewerWindow.loadFile(getPackagedRendererIndexPath(path.join(__dirname, "..")), {
			query: { theme: tone, mode: "file-viewer" },
		});
	}
}

/** 查看器渲染端就绪回调:取回并清除待打开路径(无则 null)。 */
export function consumePendingPath(): string | null {
	const path = pendingPath;
	pendingPath = null;
	return path;
}

/** 主窗口关闭时一并关闭查看器窗口。 */
export function closeViewerWindow(): void {
	if (viewerWindow && !viewerWindow.isDestroyed()) {
		viewerWindow.destroy();
	}
	viewerWindow = null;
}

/** 测试与诊断用:当前窗口是否存活。 */
export function hasViewerWindow(): boolean {
	return viewerWindow !== null && !viewerWindow.isDestroyed();
}
