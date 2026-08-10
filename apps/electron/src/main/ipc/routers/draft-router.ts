import { guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const draftRouter: IpcRouter = (ctx, register) => {
	register("draft:list", async () => {
		return { success: true, drafts: ctx.drafts.list() };
	});

	register("draft:create", async (data) => {
		return { success: true, draft: await ctx.drafts.create(guardString(data.text, "text")) };
	});

	register("draft:update", async (data) => {
		return {
			success: true,
			draft: await ctx.drafts.update(guardString(data.draftId, "draftId"), data.patch),
		};
	});

	register("draft:delete", async (data) => {
		await ctx.drafts.delete(guardString(data.draftId, "draftId"));
		return { success: true };
	});
};
