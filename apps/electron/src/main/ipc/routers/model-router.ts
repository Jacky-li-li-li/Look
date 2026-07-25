// ============================================================
// Model router — model listing and provider queries
// ============================================================

import { getAvailableModels, getProviders } from "../../models/model-queries.js";
import type { IpcRouter } from "../invoke-context.js";

export const modelRouter: IpcRouter = (ctx, register) => {
	register("model:list", async () => {
		const models = getAvailableModels(ctx.model.registry);
		return { success: true, models };
	});

	register("model:providers", async () => {
		const providers = getProviders(ctx.model.registry);
		return { success: true, providers };
	});
};
