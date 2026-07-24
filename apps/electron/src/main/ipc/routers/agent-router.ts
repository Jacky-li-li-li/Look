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
		await ctx.sessionMessaging.sendMessage(_agentId, data.message, data.images);
		return { success: true };
	});

	register("agent:activate", async (data) => {
		const sessionId = guardAgentId(data.agentId, "agentId");
		const projectId = ctx.sessionInfo.getAgentInfo(sessionId)?.projectId;
		if (projectId) await promptForProjectTrust(ctx.projectTrust, projectId, ctx.mainWindow);
		await ctx.runtimeLifecycle.activateSession(sessionId);
		return { success: true };
	});

	register("agent:create", async (data) => {
		guardOptionalString(data.name, "name");
		guardOptionalString(data.projectId, "projectId");
		if (data.imProvider && data.imProvider !== "feishu") {
			throw new Error("Unsupported IM provider");
		}
		const projectId = data.projectId ?? ctx.projectService.getActiveProject()?.id;
		if (projectId) await promptForProjectTrust(ctx.projectTrust, projectId, ctx.mainWindow);
		const id = await ctx.sessionLifecycle.createAgent({
			name: data.name,
			projectId: data.projectId,
			imProvider: data.imProvider,
		});
		return { success: true, agentId: id };
	});

	register("agent:destroy", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		await ctx.sessionLifecycle.destroyAgent(_agentId);
		return { success: true };
	});

	register("agent:abort", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		await ctx.sessionLifecycle.abortAgent(_agentId);
		return { success: true };
	});

	register("agent:switch-model", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		guardString(data.model, "model");
		try {
			await ctx.sessionControl.setModel(_agentId, data.model);
			return { success: true };
		} catch (e) {
			return { success: false, error: e instanceof Error ? e.message : "Failed to switch model" };
		}
	});

	register("agent:update-thinking", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		const _level = guardEnum(data.level, "level", ["off", "minimal", "low", "medium", "high", "xhigh"] as const);
		await ctx.sessionControl.setThinkingLevel(_agentId, _level as ThinkingLevel);
		return { success: true };
	});

	register("session:compress", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		await ctx.sessionControl.compress(_agentId);
		return { success: true };
	});

	register("agent:rename", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		guardOptionalString(data.name, "name");
		ctx.sessionControl.rename(_agentId, data.name);
		return { success: true };
	});

	register("agents:list", async () => {
		return { success: true, agents: ctx.sessionInfo.listAgents() };
	});
};
