import type { MainToRendererEvent } from "@shared/types";
import { handleAgentEvent } from "./agentHandlers";
import { appStore } from "./appStore";
import { appReadyPhaseAtom } from "./atoms";
import { handleBrowserEvent } from "./browserHandlers";
import { handleImEvent } from "./imHandlers";
import { handlePermissionEvent } from "./permissionHandlers";
import { confirmDockFileSwapIfDirty, dockedFileAtom, fileViewerDirtyAtom } from "./projectAtoms";
import { handleProjectEvent } from "./projectHandlers";
import { applyHistoryPreview, applySnapshot } from "./snapshot";
// ============================================================
// IPC Handler — thin routing entry point for main→renderer events
//
// All IPC events from the main process are dispatched to domain-specific
// handlers via discriminated-union routing. Components subscribe only to
// the Jotai atoms they render. Startup initialization is in startup.ts.
// ============================================================
import { subagentCardStatusAtom } from "./subagentAtoms";
import { handleSystemEvent } from "./systemHandlers";
import { enqueueUiEvent } from "./ui-event-processor";

export { initAppData, isStartupComplete } from "./startup";

const sharedRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Register all IPC event listeners. Call once at app startup. */
export function initIpcHandlers(api: Window["look"]): () => void {
	const unsub = api.onEvent((rawEvent: unknown) => {
		const event = rawEvent as MainToRendererEvent;

		if (handleAgentEvent(event)) return;
		if (handleBrowserEvent(event)) return;
		if (handleImEvent(event)) return;
		if (handleProjectEvent(event, sharedRefreshTimers)) return;
		if (handlePermissionEvent(event)) return;
		if (handleSystemEvent(event)) return;

		switch (event.type) {
			case "session:history-preview":
				applyHistoryPreview(event);
				if (appStore.get(appReadyPhaseAtom) < 3) appStore.set(appReadyPhaseAtom, 3);
				break;

			case "session:snapshot":
				applySnapshot(event);
				if (appStore.get(appReadyPhaseAtom) < 3) appStore.set(appReadyPhaseAtom, 3);
				break;

			case "notification:activate-session":
				// 用户点击系统桌面通知：激活对应会话。
				void window.look.activateSession(event.agentId).catch((err: unknown) => {
					console.warn("[ipcHandler] activateSession from notification failed:", err);
				});
				break;

			case "fileViewer:docked": {
				// 独立查看器窗口请求合并：主窗口右侧打开 Dock 面板展示该文件。
				// Dock 面板内有未保存修改时先确认，避免静默覆盖（2026-08-07）。
				// diffPatch 随合并事件带回，恢复与「变更面板打开」一致的 diff 语义。
				// 结果经 resolveFileViewerDock 回执主进程：确认后主进程才淡出关闭独立窗口；
				// 取消时独立窗口保持打开，文件不丢（2026-08-10 修复，此前事件发出即关窗）。
				// 仅当 Dock 面板非空时才弹确认：空面板直接合并，避免脏状态残留（关闭
				// Dock 后 fileViewerDirtyAtom 可能仍为 true）导致的误弹确认。
				const hasDockContent = appStore.get(dockedFileAtom) !== null;
				if (hasDockContent && !confirmDockFileSwapIfDirty(() => appStore.get(fileViewerDirtyAtom))) {
					void window.look.resolveFileViewerDock(false).catch(() => {});
					break;
				}
				appStore.set(dockedFileAtom, {
					absolutePath: event.path,
					...(event.diffPatch !== undefined ? { diffPatch: event.diffPatch } : {}),
				});
				void window.look.resolveFileViewerDock(true).catch(() => {});
				break;
			}

			case "session:ui-event":
				enqueueUiEvent(event.sessionId, event.events);
				break;

			case "session:subagent-progress":
			case "session:subagent-completed": {
				const status = event.type === "session:subagent-completed" ? event.result.status : event.status;
				const { toolCallId, taskTitle } = event;
				if (toolCallId && taskTitle) {
					appStore.set(subagentCardStatusAtom, (prev) => {
						const current = prev[toolCallId] ?? {};
						return { ...prev, [toolCallId]: { ...current, [taskTitle]: status } };
					});
				}
				break;
			}
		}
	});
	return unsub;
}
