// ============================================================
// History router — tree navigation, forks, labels
// ============================================================

import { guardAgentId, guardOptionalBoolean, guardOptionalString, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";
import { withTimeout } from "../with-timeout.js";

/** 树导航 + summarize 最长等待时间（summarize 走 LLM，可能长时间不返回）。 */
const NAVIGATE_TIMEOUT_MS = 10 * 60 * 1000;

export const historyRouter: IpcRouter = (ctx, register) => {
	register("agent:navigate-tree", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		const _entryId = guardString(data.entryId, "entryId");
		guardOptionalBoolean(data.summarize, "summarize");
		guardOptionalString(data.customInstructions, "customInstructions");
		guardOptionalString(data.label, "label");
		try {
			const result = await withTimeout(
				ctx.session.history.navigate(_agentId, _entryId, {
					summarize: data.summarize,
					customInstructions: data.customInstructions,
					label: data.label,
				}),
				NAVIGATE_TIMEOUT_MS,
				"Tree navigation timed out after 10 minutes",
			);
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
			const result = await ctx.session.history.fork(_agentId, _entryId, {
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
		ctx.session.history.setEntryLabel(_agentId, _entryId, data.label);
		return { success: true };
	});
};
