import type { DraftPatch } from "@look/shared/types";
import { guardNullableString, guardObject, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

function guardDraftPatch(input: unknown): DraftPatch {
	const patch = guardObject(input, "patch");
	const result: DraftPatch = {};
	if (patch.text !== undefined) result.text = guardString(patch.text, "patch.text");
	if (patch.convertedSessionId !== undefined) {
		result.convertedSessionId = guardNullableString(patch.convertedSessionId, "patch.convertedSessionId");
	}
	return result;
}

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
			draft: await ctx.drafts.update(guardString(data.draftId, "draftId"), guardDraftPatch(data.patch)),
		};
	});

	register("draft:delete", async (data) => {
		await ctx.drafts.delete(guardString(data.draftId, "draftId"));
		return { success: true };
	});
};
