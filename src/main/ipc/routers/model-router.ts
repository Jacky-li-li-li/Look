// ============================================================
// Model router — model listing and provider queries
// ============================================================

import { getAvailableModels, getProviders } from "../../models/model-queries.js";
import type { IpcRouter } from "../invoke-context.js";

export const modelRouter: IpcRouter = (ctx, register) => {
	register("model:list", async () => {
		const models = getAvailableModels(ctx.modelRegistry);
		return { success: true, models };
	});

	register("model:providers", async () => {
		const providers = getProviders(ctx.modelRegistry);
		return { success: true, providers };
	});
};
