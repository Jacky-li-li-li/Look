// ============================================================
// History router — tree navigation, forks, labels
// ============================================================

import { guardAgentId, guardOptionalBoolean, guardOptionalString, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const historyRouter: IpcRouter = (ctx, register) => {
	register("agent:navigate-tree", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		const _entryId = guardString(data.entryId, "entryId");
		guardOptionalBoolean(data.summarize, "summarize");
		guardOptionalString(data.customInstructions, "customInstructions");
		guardOptionalString(data.label, "label");
		try {
			const result = await ctx.runtimeManager.navigateTreeSession(_agentId, _entryId, {
				summarize: data.summarize,
				customInstructions: data.customInstructions,
				label: data.label,
			});
			return { success: true, result };
		} catch (e) {
			return { success: false, error: e instanceof Error ? e.message : "Failed to navigate tree" };
		}
	});

	register("agent:create-fork", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		const _entryId = guardString(data.entryId, "entryId");
		guardOptionalString(data.name, "name");
		try {
			const result = await ctx.runtimeManager.createForkedSession(_agentId, _entryId, {
				name: data.name,
			});
			return { success: true, ...result };
		} catch (e) {
			return { success: false, error: e instanceof Error ? e.message : "Failed to create fork" };
		}
	});

	register("agent:set-entry-label", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		const _entryId = guardString(data.entryId, "entryId");
		if (data.label !== null) {
			guardString(data.label, "label");
		}
		ctx.runtimeManager.setEntryLabel(_agentId, _entryId, data.label);
		return { success: true };
	});
};
