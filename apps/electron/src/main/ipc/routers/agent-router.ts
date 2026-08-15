// ============================================================
// Agent router — session send/activate/create/destroy/abort
// ============================================================

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AttachmentRef, ThinkingLevel } from "@look/shared/types";
import { assertAttachmentName } from "../../session/services/attachment-service.js";
import { guardAgentId, guardEnum, guardObject, guardOptionalString, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";
import { promptForProjectTrust } from "../project-trust.js";
import { withTimeout } from "../with-timeout.js";

/** 压缩最长等待时间（SDK compact 内部可能因 LLM 卡死而永不返回）。 */
const COMPRESS_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * ThinkingLevel 的合法取值（与 @look/shared 的 ThinkingLevel 类型同源）。
 * 用 satisfies 从类型推导，避免字面量数组与类型重复漂移。
 */
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];

/**
 * 清空队列并按原顺序重放除 excludeText 外的消息。
 * remove-queued-message 与 insert-queued-message 共用：insert 在重放后
 * 再以 steer 插入新消息，保证队列顺序正确。
 */
async function replayQueue(session: AgentSession, excludeText?: string): Promise<void> {
	const { steering, followUp } = session.clearQueue();
	for (const t of steering) {
		if (t !== excludeText) await session.steer(t);
	}
	for (const t of followUp) {
		if (t !== excludeText) await session.followUp(t);
	}
}

/**
 * 校验渲染端传来的附件引用数组（agent:send-message 使用）。
 * 每个字段在 AttachmentService 读取时还会再次校验，这里是 IPC 边界的形状守卫。
 */
function guardAttachmentRefs(x: unknown): AttachmentRef[] {
	if (x === undefined) return [];
	if (!Array.isArray(x)) throw new Error("Invalid attachments: expected array");
	return x.map((item, index) => {
		const obj = guardObject(item, `attachments[${index}]`);
		return {
			projectId: guardString(obj.projectId, `attachments[${index}].projectId`),
			sessionId: guardAgentId(obj.sessionId, `attachments[${index}].sessionId`),
			name: assertAttachmentName(obj.name),
		};
	});
}

export const agentRouter: IpcRouter = (ctx, register) => {
	register("agent:send-message", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		guardString(data.message, "message");
		const sendMode = data.sendMode === "steer" || data.sendMode === "followUp" ? data.sendMode : undefined;
		// runtime 未就绪时消息挂起（queued=true）立即返回——首条消息不被
		// 会话初始化阻塞，绑定后由 onSessionBound flush 自动发出。
		const result = await ctx.session.messaging.sendMessage(
			_agentId,
			data.message,
			data.images,
			guardAttachmentRefs(data.attachments),
			sendMode,
		);
		return { success: true, queued: result.queued };
	});

	register("agent:remove-queued-message", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		guardString(data.text, "text");
		// Serialize against agent:insert-queued-message and concurrent remove
		// calls to prevent clearQueue() interleaving that would drop messages.
		return ctx.runtime.registry.withExclusive(_agentId, async () => {
			const managed = ctx.session.info.getManagedRuntime(_agentId);
			if (!managed) return { success: false, error: "Session not found" };
			await replayQueue(managed.runtime.session, data.text);
			return { success: true };
		});
	});

	register("agent:insert-queued-message", async (data) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		guardString(data.text, "text");
		return ctx.runtime.registry.withExclusive(_agentId, async () => {
			const managed = ctx.session.info.getManagedRuntime(_agentId);
			if (!managed) return { success: false, error: "Session not found" };
			const session = managed.runtime.session;
			await replayQueue(session, data.text);
			await session.prompt(data.text, { streamingBehavior: "steer" });
			return { success: true };
		});
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
		// 返回乐观草稿（runtime 后台初始化）：agentId 立即可用，agent 行
		// 与主进程先行发出的 agent:created 事件同形，渲染端互为兜底。
		const draft = await ctx.session.lifecycle.createAgent({
			name: data.name,
			projectId,
			imProvider: data.imProvider,
		});
		return { success: true, agentId: draft.id, agent: draft };
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
		const level = guardEnum(data.level, "level", THINKING_LEVELS);
		await ctx.session.control.setThinkingLevel(_agentId, level);
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
