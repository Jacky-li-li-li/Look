// ============================================================
// Subagent router — sub-session queries, agent definitions, skill toggles
// ============================================================

import { guardAgentDefinitionInput, guardAgentId, guardBoolean, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const subagentRouter: IpcRouter = (ctx, register) => {
	register("agent:list-subagents", async (data) => {
		const parentId = guardAgentId(data.parentSessionId, "parentSessionId");
		return { success: true, childSessionIds: ctx.agent.subAgentRegistry.listChildren(parentId) };
	});

	register("agent:get-parent-session", async (data) => {
		const childId = guardAgentId(data.childSessionId, "childSessionId");
		return { success: true, parentSessionId: ctx.agent.subAgentRegistry.getParent(childId) };
	});

	register("agent:set-subagent-enabled", async (data) => {
		guardBoolean(data.enabled, "enabled");
		await ctx.agent.subagentService.setEnabledGlobal(data.enabled);
		return { success: true, enabled: data.enabled };
	});

	register("agent-definitions:list", async () => {
		return { success: true, agents: await ctx.agent.definitions.listDefinitions() };
	});

	register("agent-definitions:create", async (data) => {
		const input = guardAgentDefinitionInput(data.input);
		const agent = await ctx.agent.definitions.createDefinition(input);
		return { success: true, agent };
	});

	register("agent-definitions:update", async (data) => {
		guardString(data.name, "name");
		const input = guardAgentDefinitionInput(data.input);
		const agent = await ctx.agent.definitions.updateDefinition(data.name, input);
		return { success: true, agent };
	});

	register("agent-definitions:delete", async (data) => {
		guardString(data.name, "name");
		ctx.agent.definitions.deleteDefinition(data.name);
		return { success: true };
	});

	register("agent-definitions:install", async (data) => {
		guardString(data.name, "name");
		const agent = await ctx.agent.definitions.installDefinition(data.name);
		return { success: true, agent };
	});

	register("agent-definitions:set-enabled", async (data) => {
		guardString(data.name, "name");
		guardBoolean(data.enabled, "enabled");
		await ctx.agent.subagentService.setAgentDefinitionEnabled(data.name, data.enabled);
		return { success: true };
	});

	register("skills:set-enabled", async (data) => {
		guardString(data.name, "name");
		guardBoolean(data.enabled, "enabled");
		await ctx.skill.setEnabled(data.name, data.enabled);
		return { success: true };
	});
};
