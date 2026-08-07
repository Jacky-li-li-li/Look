import type { MainToRendererEvent } from "@shared/types";
import { handleAgentEvent } from "./agentHandlers";
import { appStore } from "./appStore";
import { appReadyPhaseAtom } from "./atoms";
import { handlePermissionEvent } from "./permissionHandlers";
import { dockedFileAtom } from "./projectAtoms";
import { handleProjectEvent } from "./projectHandlers";
import { applySnapshot } from "./snapshot";
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
		if (handleProjectEvent(event, sharedRefreshTimers)) return;
		if (handlePermissionEvent(event)) return;
		if (handleSystemEvent(event)) return;

		switch (event.type) {
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

			case "fileViewer:docked":
				// 独立查看器窗口请求合并：主窗口右侧打开 Dock 面板展示该文件。
				appStore.set(dockedFileAtom, { absolutePath: event.path });
				break;

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
