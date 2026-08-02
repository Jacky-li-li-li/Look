// ============================================================
// Look Island router — island user settings (macOS)
// ============================================================

import { guardBoolean } from "../ipc/guards.js";
import type { IpcRouter } from "../ipc/invoke-context.js";

export const lookIslandRouter: IpcRouter = (ctx, register) => {
	register("look-island:get-settings", async () => {
		if (!ctx.lookIsland) {
			return { success: false, error: "Look Island is not supported on this platform" };
		}
		return { success: true, settings: ctx.lookIsland.getSettings() };
	});

	register("look-island:set-enabled", async (data) => {
		if (!ctx.lookIsland) {
			return { success: false, error: "Look Island is not supported on this platform" };
		}
		const enabled = guardBoolean(data.enabled, "enabled");
		const settings = ctx.lookIsland.setEnabled(enabled);
		return { success: true, settings };
	});
};
