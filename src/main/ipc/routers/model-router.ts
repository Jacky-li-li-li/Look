// ============================================================
// Model router — model listing and provider queries
// ============================================================

import type { IpcRouter } from "../invoke-context.js";

export const modelRouter: IpcRouter = (ctx, register) => {
	register("model:list", async () => {
		const models = await ctx.runtimeManager.getAvailableModels();
		return { success: true, models };
	});

	register("model:providers", async () => {
		const providers = await ctx.runtimeManager.getProviders();
		return { success: true, providers };
	});
};
