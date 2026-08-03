import type { MainToRendererEvent } from "@shared/types";
import { appStore } from "./appStore";
import {
	type AppUpdateState,
	appUpdateAtom,
	loginCompletedAtom,
	loginPromptAtom,
	mcpStatusVersionAtom,
	modelUpdatedVersionAtom,
	usageDataAtom,
	usageVersionAtom,
	windowFullscreenAtom,
} from "./atoms";

export function handleSystemEvent(event: MainToRendererEvent): boolean {
	switch (event.type) {
		case "mcp:status-changed":
			appStore.set(mcpStatusVersionAtom, (prev) => prev + 1);
			return true;

		case "model:updated":
			appStore.set(modelUpdatedVersionAtom, (prev) => prev + 1);
			return true;

		case "usage:updated": {
			appStore.set(usageVersionAtom, (prev) => prev + 1);
			void window.look
				.getUsage()
				.then((result) => {
					const r = result as {
						success: boolean;
						usage?: import("../store/atoms").UsageAtomData;
					};
					if (r?.success && r.usage) {
						appStore.set(usageDataAtom, r.usage);
					}
				})
				.catch((err: unknown) => {
					console.error("[ipcHandler] usage:updated refresh failed:", err);
				});
			return true;
		}

		case "login:prompt": {
			appStore.set(loginPromptAtom, {
				providerId: event.providerId,
				promptId: event.promptId,
				providerName: event.providerId,
				prompt: event.prompt,
			});
			return true;
		}

		case "login:completed": {
			appStore.set(loginPromptAtom, null);
			appStore.set(loginCompletedAtom, {
				providerId: event.providerId,
				success: event.success,
				error: event.error,
			});
			return true;
		}

		case "update:status": {
			// update:status 事件按增量字段设计，各阶段合法字段不同：
			// available/downloaded 带 version；downloading 带 percent（version 从上一阶段继承）；
			// error 带 error；checking/not-available 不带业务字段。
			// 按 phase 白名单重组，避免残留字段跨周期复活（如 error 写入后无法清除、
			// not-available 后 version/percent 残留）。
			appStore.set(appUpdateAtom, (prev) => {
				const base: AppUpdateState = { phase: event.phase };
				if (event.phase === "available" || event.phase === "downloaded") {
					base.version = event.version;
				} else if (event.phase === "downloading") {
					base.version = event.version ?? prev?.version;
					base.percent = event.percent ?? 0;
				} else if (event.phase === "error") {
					base.error = event.error;
				}
				return base;
			});
			return true;
		}

		case "window:fullscreen-changed": {
			appStore.set(windowFullscreenAtom, event.fullscreen);
			return true;
		}

		default:
			return false;
	}
}
