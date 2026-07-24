import type { MainToRendererEvent } from "@shared/types";
import { appStore } from "./appStore";
import {
	loginCompletedAtom,
	loginPromptAtom,
	mcpStatusVersionAtom,
	updateStatusAtom,
	usageDataAtom,
	usageVersionAtom,
} from "./atoms";

export function handleSystemEvent(event: MainToRendererEvent): boolean {
	switch (event.type) {
		case "update:checking":
			appStore.set(updateStatusAtom, { stage: "checking" });
			return true;

		case "update:available":
			appStore.set(updateStatusAtom, { stage: "available", version: event.version });
			return true;

		case "update:not-available":
			appStore.set(updateStatusAtom, { stage: "not-available" });
			return true;

		case "update:download-progress":
			appStore.set(updateStatusAtom, { stage: "downloading", percent: event.percent });
			return true;

		case "update:downloaded":
			appStore.set(updateStatusAtom, { stage: "downloaded", version: event.version });
			return true;

		case "update:error":
			appStore.set(updateStatusAtom, { stage: "error", message: event.message });
			return true;

		case "mcp:status-changed":
			appStore.set(mcpStatusVersionAtom, (prev) => prev + 1);
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

		default:
			return false;
	}
}
