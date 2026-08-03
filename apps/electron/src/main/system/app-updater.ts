// ============================================================
// App Updater — electron-updater 封装
//
// 仅在打包环境启用；更新源为 GitHub Releases（electron-builder.yml 的
// publish provider）。策略：自动检查、自动下载、下载完成后等待用户手动
// 重启安装（autoDownload=true + autoInstallOnAppQuit=false）。
// 渲染层通过 update:status 事件感知状态，通过 update:* IPC 触发动作。
// macOS 关窗不退出期间事件会丢失，主进程持有 lastStatus，
// 窗口 did-finish-load / 系统唤醒时重放并节流补检。
// ============================================================

import type { AppUpdatePhase, MainToRendererEvent } from "@look/shared/types";
import { app } from "electron";
import updater from "electron-updater";

/**
 * electron-updater 的 autoUpdater 是惰性 getter，首次访问才会创建
 * ElectronAppAdapter（内部读 app.getVersion()）。在模块顶层解构会
 * 把该副作用提前到 import 时，导致非 Electron 环境（vitest）导入
 * 本模块即崩溃——因此改为按需惰性获取。
 */
function getAutoUpdater() {
	return updater.autoUpdater;
}

const INITIAL_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** 窗口就绪/唤醒时补检的最小间隔，避免频繁请求 GitHub */
const MIN_CHECK_GAP_MS = 10 * 60 * 1000;

type UpdateStatus = { phase: AppUpdatePhase; version?: string; percent?: number; error?: string };
type SendEvent = (event: MainToRendererEvent) => void;

let initialized = false;
let sendEvent: SendEvent | null = null;
/** 最近一次更新状态。无窗口期间（macOS 关窗不退出）事件会被丢弃，
 * 窗口重建后靠 replayUpdateStatus 恢复提示。 */
let lastStatus: UpdateStatus | null = null;
let lastCheckAt = 0;
/** 重启安装是否已触发（侧边栏/设置页双入口幂等守卫）。 */
let installTriggered = false;

function emit(phase: AppUpdatePhase, extra?: { version?: string; percent?: number; error?: string }): void {
	lastStatus = { phase, ...extra };
	console.log(`[Look][updater] ${phase}`, extra ?? "");
	sendEvent?.({ type: "update:status", ...lastStatus });
}

/** 把最近一次更新状态重发给当前渲染层（窗口 did-finish-load 后调用）。 */
export function replayUpdateStatus(): void {
	// "checking" 是瞬时态，重放只会让 UI 显示一个不会结束的 spinner
	if (!lastStatus || lastStatus.phase === "checking") return;
	sendEvent?.({ type: "update:status", ...lastStatus });
}

/** 窗口就绪 / 系统唤醒时的节流补检：距上次检查不足间隔则跳过。 */
export async function requestFreshCheck(): Promise<void> {
	if (!app.isPackaged) return;
	if (Date.now() - lastCheckAt < MIN_CHECK_GAP_MS) return;
	await checkForUpdates();
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

	// 自动下载：checkForUpdates() 发现新版本后立即开始下载，无需用户点击。
	// 下载完成后停留在 downloaded 阶段，由用户手动触发重启安装。
	const updaterApi = getAutoUpdater();
	updaterApi.autoDownload = true;
	updaterApi.autoInstallOnAppQuit = false;

	updaterApi.on("checking-for-update", () => emit("checking"));
	updaterApi.on("update-available", (info) => emit("available", { version: info.version }));
	updaterApi.on("update-not-available", () => emit("not-available"));
	updaterApi.on("download-progress", (progress) =>
		// 保留最近一次的 version：download-progress 事件本身不带版本号，
		// 否则渲染层 downloading 阶段会丢失 available 阶段的 version。
		emit("downloading", { percent: Math.round(progress.percent), version: lastStatus?.version }),
	);
	updaterApi.on("update-downloaded", (info) => {
		// 不再自动重启：下载完成仅通知渲染层，等待用户手动点击重启安装。
		emit("downloaded", { version: info.version });
	});
	updaterApi.on("error", (err) => emit("error", { error: err instanceof Error ? err.message : String(err) }));

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
	lastCheckAt = Date.now();
	try {
		await getAutoUpdater().checkForUpdates();
		return { success: true };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export async function downloadUpdate(): Promise<{ success: boolean; error?: string }> {
	if (!app.isPackaged) return devError();
	try {
		await getAutoUpdater().downloadUpdate();
		return { success: true };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export async function installUpdate(): Promise<{ success: boolean; error?: string }> {
	if (!app.isPackaged) return devError();
	// 幂等守卫：侧边栏胶囊与设置页 About 双入口可能先后触发，第二次直接返回
	// success，避免重复调用 quitAndInstall（electron-updater 对重复调用可能抛错）。
	if (installTriggered) return { success: true };
	installTriggered = true;
	// 用户手动点击重启更新：延迟到 IPC 响应送达渲染层后再退出安装。
	// quitAndInstall 抛错时通过 error 事件反馈（渲染层据此离开 installing 态），
	// 避免「应用未退出但按钮永久禁用」的卡死。
	setImmediate(() => {
		try {
			getAutoUpdater().quitAndInstall();
		} catch (err) {
			emit("error", { error: err instanceof Error ? err.message : String(err) });
		}
	});
	return { success: true };
}
