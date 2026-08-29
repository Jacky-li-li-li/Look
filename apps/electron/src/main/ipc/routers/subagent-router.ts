// ============================================================
// Subagent router — sub-session queries, agent definitions, skill toggles
// ============================================================

import { findExistingReviewSession, REVIEW_TITLE } from "../../extensions/subagent/review-session-finder.js";
import { guardAgentDefinitionInput, guardAgentId, guardBoolean, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const subagentRouter: IpcRouter = (ctx, register) => {
	register("agent:set-subagent-enabled", async (data) => {
		guardBoolean(data.enabled, "enabled");
		await ctx.agent.subagentService.setEnabledGlobal(data.enabled);
		return { success: true, enabled: data.enabled };
	});

	register("agent:review-changes", async (data) => {
		const parentSessionId = guardAgentId(data.parentSessionId, "parentSessionId");
		const title = guardString(data.title, "title").trim() || REVIEW_TITLE;
		const turnKey = guardString(data.turnKey, "turnKey").trim();

		// 审核会话由主 Agent 通过 subagent 工具创建（消息流可见 subagent 工具卡）。
		// 本路由只负责「查找已有审核子会话」（防重复）：命中返回 childSessionId，
		// 未命中返回 null，由渲染端注入 /subagent:reviewer 委派指令。
		const existing = await findExistingReviewSession(parentSessionId, turnKey, `Agent：${title}`, (sessionId) =>
			ctx.session.info.getStoredSession(sessionId),
		);
		return { success: true, childSessionId: existing ?? null, title };
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
