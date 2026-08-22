// ============================================================
// imHandlers — IM 域事件 → atoms
//
// ImChannelsTab 此前绕过 initIpcHandlers 直接订阅 onEvent 并手工
// 断言 unknown 载荷；现在与其他域一致：ipcHandler 统一路由到
// 这里，载荷类型来自共享事件契约。
// ============================================================

import type { MainToRendererEvent } from "@shared/types";
import { appStore } from "./appStore";
import { imChannelsAtom, imRecentMessageAtom, imRegistrationAtom } from "./imAtoms";

export function handleImEvent(event: MainToRendererEvent): boolean {
	switch (event.type) {
		case "im:registration-update": {
			const { type: _type, ...payload } = event;
			appStore.set(imRegistrationAtom, payload);
			return true;
		}

		case "im:channel-status":
			appStore.set(imChannelsAtom, (prev) =>
				prev.map((ch) =>
					ch.provider === event.provider && ch.appId === event.appId
						? {
								...ch,
								status: event.status,
								connected: event.status === "connected",
								error: event.error,
							}
						: ch,
				),
			);
			return true;

		case "im:message-received":
			appStore.set(imRecentMessageAtom, event);
			return true;

		default:
			return false;
	}
}
