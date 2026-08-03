// ============================================================
// useAppUpdate — 应用自动更新状态（appUpdateAtom）+ IPC 操作封装
//
// 状态由主进程 update:status 事件驱动（见 store/systemHandlers.ts）。
// IPC 调用本身失败时（如开发环境下主进程未启用 updater）
// 本地回退写入 error 阶段，保证 UI 有反馈。
// ============================================================

import { useAtomValue } from "jotai";
import { useCallback } from "react";
import { appStore } from "../store/appStore";
import { appUpdateAtom } from "../store/atoms";

const api = window.look;

type UpdateIpcResult = { success: boolean; error?: string };

function fallbackError(result: UpdateIpcResult) {
	if (!result.success) {
		appStore.set(appUpdateAtom, { phase: "error", error: result.error });
	}
	return result;
}

export function useAppUpdate() {
	const update = useAtomValue(appUpdateAtom);

	const checkForUpdates = useCallback(async () => {
		if (!api) return { success: false, error: "Harness API not available" };
		return fallbackError(await api.checkForUpdates());
	}, []);

	const downloadUpdate = useCallback(async () => {
		if (!api) return { success: false, error: "Harness API not available" };
		return fallbackError(await api.downloadUpdate());
	}, []);

	const installUpdate = useCallback(async () => {
		if (!api) return { success: false, error: "Harness API not available" };
		return fallbackError(await api.installUpdate());
	}, []);

	return { update, checkForUpdates, downloadUpdate, installUpdate };
}
