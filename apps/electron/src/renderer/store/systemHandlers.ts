import type { MainToRendererEvent } from "@shared/types";
import { appStore } from "./appStore";
import {
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
			appStore.set(appUpdateAtom, {
				phase: event.phase,
				version: event.version,
				percent: event.percent,
				error: event.error,
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
