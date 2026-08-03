// ============================================================
// app-updater tests — 状态重放 / 节流补检 / 打包门控
//
// 背景：macOS 关窗不退出时应用常驻后台，期间轮询到的 update:status
// 事件无处投递会被丢弃；主进程必须持有 lastStatus 并在窗口就绪时
// 重放，否则用户只能靠手动检查发现新版本。
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const { EventEmitter } = require("node:events");
	const autoUpdater = new EventEmitter();
	autoUpdater.checkForUpdates = vi.fn(async () => undefined);
	autoUpdater.downloadUpdate = vi.fn(async () => undefined);
	autoUpdater.quitAndInstall = vi.fn();
	return { autoUpdater };
});

vi.mock("electron", () => ({
	app: { isPackaged: true },
}));

vi.mock("electron-updater", () => ({
	default: { autoUpdater: mocks.autoUpdater },
}));

type AppUpdaterModule = typeof import("../../src/main/system/app-updater.js");

let mod: AppUpdaterModule;

beforeEach(async () => {
	mocks.autoUpdater.removeAllListeners();
	mocks.autoUpdater.checkForUpdates.mockClear();
	mocks.autoUpdater.quitAndInstall.mockClear();
	vi.resetModules();
	mod = await import("../../src/main/system/app-updater.js");
});

describe("app-updater", () => {
	it("重放最近一次更新状态给新的渲染层（窗口重建场景）", () => {
		const firstSend = vi.fn();
		mod.initAppUpdater(firstSend);
		mocks.autoUpdater.emit("update-available", { version: "9.9.9" });
		expect(firstSend).toHaveBeenCalledWith({ type: "update:status", phase: "available", version: "9.9.9" });

		// 窗口重建后 initAppUpdater 仅替换事件出口；did-finish-load 时重放
		const secondSend = vi.fn();
		mod.initAppUpdater(secondSend);
		mod.replayUpdateStatus();
		expect(secondSend).toHaveBeenCalledWith({ type: "update:status", phase: "available", version: "9.9.9" });
	});

	it("不重放 checking 瞬时态", () => {
		const send = vi.fn();
		mod.initAppUpdater(send);
		mocks.autoUpdater.emit("checking-for-update");
		send.mockClear();
		mod.replayUpdateStatus();
		expect(send).not.toHaveBeenCalled();
	});

	it("requestFreshCheck 在节流间隔内跳过重复检查", async () => {
		mod.initAppUpdater(vi.fn());
		await mod.requestFreshCheck();
		await mod.requestFreshCheck();
		expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
	});

	it("手动检查后 requestFreshCheck 被节流跳过", async () => {
		mod.initAppUpdater(vi.fn());
		await mod.checkForUpdates();
		expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
		await mod.requestFreshCheck();
		expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
	});

	it("自动下载模式：autoDownload=true，下载完成后不自动重启", () => {
		const send = vi.fn();
		mod.initAppUpdater(send);

		// 发现更新后自动下载，但绝不自动安装
		expect(mocks.autoUpdater.autoDownload).toBe(true);
		expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false);

		mocks.autoUpdater.emit("update-available", { version: "9.9.9" });
		mocks.autoUpdater.emit("download-progress", { percent: 42 });
		mocks.autoUpdater.emit("update-downloaded", { version: "9.9.9" });

		// download-progress 事件保留先前 version，渲染层 downloading 阶段不丢字段
		expect(send).toHaveBeenCalledWith({
			type: "update:status",
			phase: "downloading",
			percent: 42,
			version: "9.9.9",
		});
		// 停留在 downloaded 阶段等待用户手动重启，不调用 quitAndInstall
		expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
		expect(send).toHaveBeenLastCalledWith({ type: "update:status", phase: "downloaded", version: "9.9.9" });
	});

	it("installUpdate 由用户手动触发重启安装", async () => {
		mod.initAppUpdater(vi.fn());
		await mod.installUpdate();
		// quitAndInstall 延迟到 IPC 响应送达后再执行（setImmediate）
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
	});

	it("installUpdate 幂等：双入口重复触发只执行一次 quitAndInstall", async () => {
		const send = vi.fn();
		mod.initAppUpdater(send);
		await mod.installUpdate();
		await mod.installUpdate(); // 侧边栏/设置页双入口二次触发
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
	});

	it("downloading 状态重放带 version（窗口重建后进度不丢版本号）", () => {
		const send = vi.fn();
		mod.initAppUpdater(send);
		mocks.autoUpdater.emit("update-available", { version: "9.9.9" });
		mocks.autoUpdater.emit("download-progress", { percent: 42 });
		send.mockClear();
		mod.replayUpdateStatus();
		expect(send).toHaveBeenCalledWith({
			type: "update:status",
			phase: "downloading",
			percent: 42,
			version: "9.9.9",
		});
	});
});
