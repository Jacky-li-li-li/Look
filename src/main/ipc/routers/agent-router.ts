// ============================================================
// Agent router — session send/activate/create/destroy/abort
// ============================================================

import type { ThinkingLevel } from "@look/shared/types";
import { guardAgentId, guardEnum, guardOptionalString, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";
import { promptForProjectTrust } from "../project-trust.js";

export const agentRouter: IpcRouter = (ctx, register) => {
	register("agent:send-message", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		guardString(data.message, "message");
		await ctx.runtimeManager.sendMessage(_agentId, data.message, data.images);
		return { success: true };
	});

	register("agent:activate", async (data) => {
		const sessionId = guardAgentId(data.agentId, "agentId");
		const projectId = ctx.runtimeManager.getAgentInfo(sessionId)?.projectId;
		if (projectId) await promptForProjectTrust(ctx.runtimeManager, projectId, ctx.mainWindow);
		await ctx.runtimeManager.activateSession(sessionId);
		return { success: true };
	});

	register("agent:create", async (data) => {
		guardOptionalString(data.name, "name");
		guardOptionalString(data.projectId, "projectId");
		const projectId = data.projectId ?? ctx.runtimeManager.getActiveProject()?.id;
		if (projectId) await promptForProjectTrust(ctx.runtimeManager, projectId, ctx.mainWindow);
		const id = await ctx.runtimeManager.createAgent({ name: data.name, projectId: data.projectId });
		return { success: true, agentId: id };
	});

	register("agent:destroy", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		await ctx.runtimeManager.destroyAgent(_agentId);
		return { success: true };
	});

	register("agent:abort", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		await ctx.runtimeManager.abortAgent(_agentId);
		return { success: true };
	});

	register("agent:switch-model", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		guardString(data.model, "model");
		try {
			await ctx.runtimeManager.setModel(_agentId, data.model);
			return { success: true };
		} catch (e) {
			return { success: false, error: e instanceof Error ? e.message : "Failed to switch model" };
		}
	});

	register("agent:update-thinking", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		const _level = guardEnum(data.level, "level", ["off", "minimal", "low", "medium", "high", "xhigh"] as const);
		await ctx.runtimeManager.setThinkingLevel(_agentId, _level as ThinkingLevel);
		return { success: true };
	});

	register("session:compress", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		await ctx.runtimeManager.compressSession(_agentId);
		return { success: true };
	});

	register("agent:rename", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		guardOptionalString(data.name, "name");
		ctx.runtimeManager.renameAgent(_agentId, data.name);
		return { success: true };
	});

	register("agents:list", async () => {
		return { success: true, agents: ctx.runtimeManager.listAgents() };
	});
};
