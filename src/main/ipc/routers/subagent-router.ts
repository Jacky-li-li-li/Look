// ============================================================
// Subagent router — sub-session queries, agent definitions, skill toggles
// ============================================================

import { guardAgentDefinitionInput, guardAgentId, guardBoolean, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const subagentRouter: IpcRouter = (ctx, register) => {
	register("agent:list-subagents", async (data) => {
		const parentId = guardAgentId(data.parentSessionId, "parentSessionId");
		return { success: true, childSessionIds: ctx.runtimeManager.listSubSessions(parentId) };
	});

	register("agent:get-parent-session", async (data) => {
		const childId = guardAgentId(data.childSessionId, "childSessionId");
		return { success: true, parentSessionId: ctx.runtimeManager.getParentSession(childId) };
	});

	register("agent:set-subagent-enabled", async (data) => {
		guardBoolean(data.enabled, "enabled");
		await ctx.runtimeManager.setSubagentEnabledGlobal(data.enabled);
		return { success: true, enabled: data.enabled };
	});

	register("agent-definitions:list", async () => {
		return { success: true, agents: await ctx.runtimeManager.listAgentDefinitions() };
	});

	register("agent-definitions:create", async (data) => {
		const input = guardAgentDefinitionInput(data.input);
		const agent = await ctx.runtimeManager.createAgentDefinition(input);
		return { success: true, agent };
	});

	register("agent-definitions:update", async (data) => {
		guardString(data.name, "name");
		const input = guardAgentDefinitionInput(data.input);
		const agent = await ctx.runtimeManager.updateAgentDefinition(data.name, input);
		return { success: true, agent };
	});

	register("agent-definitions:delete", async (data) => {
		guardString(data.name, "name");
		ctx.runtimeManager.deleteAgentDefinition(data.name);
		return { success: true };
	});

	register("agent-definitions:install", async (data) => {
		guardString(data.name, "name");
		const agent = await ctx.runtimeManager.installAgentDefinition(data.name);
		return { success: true, agent };
	});

	register("agent-definitions:set-enabled", async (data) => {
		guardString(data.name, "name");
		guardBoolean(data.enabled, "enabled");
		await ctx.runtimeManager.setAgentDefinitionEnabled(data.name, data.enabled);
		return { success: true };
	});

	register("skills:set-enabled", async (data) => {
		guardString(data.name, "name");
		guardBoolean(data.enabled, "enabled");
		await ctx.runtimeManager.setSkillEnabled(data.name, data.enabled);
		return { success: true };
	});
};
