// ============================================================
// Viewer Window Manager — 独立原生文件查看器窗口
//
// 单例窗口:fileViewer:open 时若已存在则聚焦并转发路径,否则创建新窗口。
// 渲染端以 ?mode=file-viewer 启动纯查看器应用;主题与主窗口一致(读取持久化设置)。
//
// 动画状态机:每个新操作(open/close/fadeOut)都会作废在途透明度动画
// (animationEpoch),避免"淡出中途重新打开被误关 / 旧动画回调清掉新窗口引用"。
// ============================================================

import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOOK_TONE_WINDOW_BG } from "@look/shared";
import { getUiSettingsPath } from "@look/shared/look-storage";
import { app, type BrowserWindow, BrowserWindow as ElectronBrowserWindow } from "electron";
import { BrowserWindowEventTransport } from "../ipc/renderer-event-transport.js";
import { readThemeToneSync } from "../settings/store.js";
import { getPackagedRendererIndexPath } from "../system/renderer-paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = (): boolean => !app.isPackaged;

/** 窗口透明度动画时长（ms），与主窗口 Dock 面板滑入时长（260ms）衔接。 */
const FADE_MS = 220;

/** 在途动画世代:每次新动画/窗口操作自增,旧动画 step 检测到世代不匹配即自行停止。 */
let animationEpoch = 0;

/** 缓动后的透明度动画:setTimeout 循环 setOpacity,从 from 渐变到 to(ease-out cubic)。
 *   Electron 主进程没有 requestAnimationFrame,用 ~16ms 定时器模拟 60fps。
 *   任何新的窗口操作(open/close/fadeOut)都会作废本动画。 */
function animateWindowOpacity(
	win: BrowserWindow,
	from: number,
	to: number,
	durationMs: number,
	onDone?: () => void,
): void {
	const epoch = ++animationEpoch;
	const start = performance.now();
	const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
	const step = (): void => {
		// 新操作已接管窗口:静默停止,不执行 onDone(避免误关新窗口)
		if (epoch !== animationEpoch) return;
		if (win.isDestroyed() || win.webContents.isDestroyed()) {
			onDone?.();
			return;
		}
		const progress = Math.min(1, (performance.now() - start) / durationMs);
		win.setOpacity(from + (to - from) * easeOutCubic(progress));
		if (progress < 1) {
			setTimeout(step, 16);
		} else {
			onDone?.();
		}
	};
	step();
}

let viewerWindow: BrowserWindow | null = null;
const viewerEvents = new BrowserWindowEventTransport(() => viewerWindow);
/** 窗口已创建但渲染端尚未就绪时暂存的待打开请求（路径 + 可选 diffPatch），由 fileViewer:ready 一次性消费。 */
let pendingRequest: { path: string; diffPatch?: string } | null = null;

function sendOpenPath(path: string, diffPatch?: string): void {
	viewerEvents.send({
		type: "fileViewer:open-path",
		path,
		...(diffPatch !== undefined ? { diffPatch } : {}),
	});
}

/** 主窗口入口:在独立查看器窗口中打开指定文件。fadeIn 时窗口淡入展示(用于从主窗口 Dock 面板弹回)。 */
export function openViewerWindow(absolutePath: string, options?: { fadeIn?: boolean; diffPatch?: string }): void {
	if (viewerWindow && !viewerWindow.isDestroyed()) {
		// 作废旧淡出/淡入动画,避免淡出中途被重新打开误关窗口
		animationEpoch += 1;
		viewerWindow.focus();
		sendOpenPath(absolutePath, options?.diffPatch);
		// 复用已有窗口时复位透明度(避免残留淡入态),不做重复动画
		viewerWindow.setOpacity(1);
		return;
	}

	pendingRequest = {
		path: absolutePath,
		...(options?.diffPatch !== undefined ? { diffPatch: options.diffPatch } : {}),
	};
	const tone = readThemeToneSync(getUiSettingsPath());
	const fadeIn = options?.fadeIn ?? false;

	viewerWindow = new ElectronBrowserWindow({
		width: 960,
		height: 720,
		minWidth: 480,
		minHeight: 320,
		title: "文件查看器",
		backgroundColor: LOOK_TONE_WINDOW_BG[tone],
		icon: path.join(__dirname, "../assets/icon-1024.png"),
		webPreferences: {
			preload: path.join(__dirname, "../preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	if (fadeIn) viewerWindow.setOpacity(0);

	const win = viewerWindow;
	win.on("closed", () => {
		if (viewerWindow === win) viewerWindow = null;
	});

	if (fadeIn) {
		// 加载完成后淡入;加载失败也复位透明度,避免窗口永久隐形
		const win = viewerWindow;
		const fadeInOnce = (): void => {
			if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
				animateWindowOpacity(win, 0, 1, FADE_MS);
			}
		};
		const failSafe = (): void => {
			// did-fail-load(dev server 未启动/资源缺失):直接可见,让用户看到错误页
			if (win && !win.isDestroyed()) win.setOpacity(1);
		};
		win.webContents.once("did-finish-load", fadeInOnce);
		win.webContents.once("did-fail-load", failSafe);
	}

	if (isDev()) {
		viewerWindow.loadURL(`http://localhost:5174?theme=${tone}&mode=file-viewer`);
	} else {
		viewerWindow.loadFile(getPackagedRendererIndexPath(path.join(__dirname, "..")), {
			query: { theme: tone, mode: "file-viewer" },
		});
	}
}

/** 查看器渲染端就绪回调:取回并清除待打开请求(无则 null)。 */
export function consumePendingPath(): { path: string; diffPatch?: string } | null {
	const request = pendingRequest;
	pendingRequest = null;
	return request;
}

/** 独立窗口淡出后关闭:用于"合并到主窗口"时与主窗口 Dock 面板滑入同步。 */
export function fadeOutAndCloseViewer(): void {
	const win = viewerWindow;
	if (!win || win.isDestroyed()) {
		if (viewerWindow === win) viewerWindow = null;
		return;
	}
	animateWindowOpacity(win, win.getOpacity(), 0, FADE_MS, () => {
		if (viewerWindow === win) viewerWindow = null;
		if (win && !win.isDestroyed()) win.close();
	});
}

/**
 * 主窗口对 fileViewer:docked 合并请求的回执：
 * confirmed=true → 淡出关闭独立窗口（与 Dock 面板滑入同步）；
 * confirmed=false（主窗口脏确认被用户取消）→ 保持窗口打开、复位透明度并
 * 重新聚焦，文件仍留在独立窗口，不会两端皆失（2026-08-10 修复）。
 */
export function resolveViewerDock(confirmed: boolean): void {
	if (confirmed) {
		fadeOutAndCloseViewer();
		return;
	}
	const win = viewerWindow;
	if (!win || win.isDestroyed()) {
		if (viewerWindow === win) viewerWindow = null;
		return;
	}
	// 作废在途动画，复位为完全不透明并夺回焦点
	animationEpoch += 1;
	win.setOpacity(1);
	win.focus();
}

/** 主窗口关闭时一并关闭查看器窗口。 */
export function closeViewerWindow(): void {
	// 作废在途动画,防止旧回调引用已销毁窗口
	animationEpoch += 1;
	if (viewerWindow && !viewerWindow.isDestroyed()) {
		viewerWindow.destroy();
	}
	viewerWindow = null;
}

/** 测试与诊断用:当前窗口是否存活。 */
export function hasViewerWindow(): boolean {
	return viewerWindow !== null && !viewerWindow.isDestroyed();
}
