// ============================================================
// Agent router — session send/activate/create/destroy/abort
// ============================================================

import type { ThinkingLevel } from "@look/shared/types";
import { guardAgentId, guardEnum, guardOptionalString, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";
import { promptForProjectTrust } from "../project-trust.js";
import { withTimeout } from "../with-timeout.js";

/** 压缩最长等待时间（SDK compact 内部可能因 LLM 卡死而永不返回）。 */
const COMPRESS_TIMEOUT_MS = 15 * 60 * 1000;

export const agentRouter: IpcRouter = (ctx, register) => {
	register("agent:send-message", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		guardString(data.message, "message");
		const sendMode = data.sendMode === "steer" || data.sendMode === "followUp" ? data.sendMode : undefined;
		await ctx.session.messaging.sendMessage(_agentId, data.message, data.images, sendMode);
		return { success: true };
	});

	register("agent:remove-queued-message", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		guardString(data.text, "text");
		const managed = ctx.session.info.getManagedRuntime(_agentId);
		if (!managed) return { success: false, error: "Session not found" };
		const session = managed.runtime.session;
		const { steering, followUp } = session.clearQueue();
		// Re-queue everything except the removed message
		for (const t of steering) {
			if (t !== data.text) await session.steer(t);
		}
		for (const t of followUp) {
			if (t !== data.text) await session.followUp(t);
		}
		return { success: true };
	});

	register("agent:insert-queued-message", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		guardString(data.text, "text");
		const managed = ctx.session.info.getManagedRuntime(_agentId);
		if (!managed) return { success: false, error: "Session not found" };
		const session = managed.runtime.session;
		const { steering, followUp } = session.clearQueue();
		// Re-queue everything except the one we're inserting
		for (const t of steering) {
			if (t !== data.text) await session.steer(t);
		}
		for (const t of followUp) {
			if (t !== data.text) await session.followUp(t);
		}
		// Send the removed message immediately as steer (interrupt)
		await session.prompt(data.text, { streamingBehavior: "steer" });
		return { success: true };
	});

	register("agent:activate", async (data) => {
		const sessionId = guardAgentId(data.agentId, "agentId");
		const projectId = ctx.session.info.getAgentInfo(sessionId)?.projectId;
		if (projectId) await promptForProjectTrust(ctx.project.trust, projectId, ctx.mainWindow);
		await ctx.runtime.lifecycle.activateSession(sessionId, { skipSnapshot: data.skipSnapshot === true });
		return { success: true };
	});

	register("agent:create", async (data) => {
		guardOptionalString(data.name, "name");
		guardOptionalString(data.projectId, "projectId");
		if (data.imProvider && data.imProvider !== "feishu") {
			throw new Error("Unsupported IM provider");
		}
		const projectId = data.projectId ?? ctx.project.service.getActiveProject()?.id;
		if (projectId) await promptForProjectTrust(ctx.project.trust, projectId, ctx.mainWindow);
		const id = await ctx.session.lifecycle.createAgent({
			name: data.name,
			projectId,
			imProvider: data.imProvider,
		});
		return { success: true, agentId: id };
	});

	register("agent:destroy", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		await ctx.session.lifecycle.destroyAgent(_agentId);
		return { success: true };
	});

	register("agent:abort", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		await ctx.session.lifecycle.abortAgent(_agentId);
		return { success: true };
	});

	register("agent:switch-model", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		guardString(data.model, "model");
		try {
			await ctx.session.control.setModel(_agentId, data.model);
			return { success: true };
		} catch (e) {
			return { success: false, error: e instanceof Error ? e.message : "Failed to switch model" };
		}
	});

	register("agent:update-thinking", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		const _level = guardEnum(data.level, "level", [
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		] as const);
		await ctx.session.control.setThinkingLevel(_agentId, _level as ThinkingLevel);
		return { success: true };
	});

	register("session:compress", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		guardOptionalString(data.customInstructions, "customInstructions");
		try {
			// 超时兜底：SDK compact 挂起时不能永久占用 IPC 通道。
			await withTimeout(
				ctx.session.control.compress(_agentId, data.customInstructions),
				COMPRESS_TIMEOUT_MS,
				"Compaction timed out after 15 minutes",
			);
			return { success: true };
		} catch (e) {
			return { success: false, error: e instanceof Error ? e.message : "Compaction failed" };
		}
	});

	register("session:abort-compress", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		ctx.session.control.abortCompress(_agentId);
		return { success: true };
	});

	register("agent:rename", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		guardOptionalString(data.name, "name");
		ctx.session.control.rename(_agentId, data.name);
		return { success: true };
	});

	register("agents:list", async () => {
		return { success: true, agents: ctx.session.info.listAgents() };
	});
};
