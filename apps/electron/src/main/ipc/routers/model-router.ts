// ============================================================
// Model router — model listing and provider queries
// ============================================================

import { getAvailableModels } from "../../models/model-queries.js";
import type { IpcRouter } from "../invoke-context.js";

export const modelRouter: IpcRouter = (ctx, register) => {
	register("model:list", async () => {
		const models = getAvailableModels(ctx.model.registry);
		return { success: true, models };
	});
};
