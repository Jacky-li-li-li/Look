// ============================================================
// Permission / Plan router
// ============================================================

import type { PermissionMode } from "@look/shared/types";
import { guardAgentId, guardEnum, guardObject, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const permissionRouter: IpcRouter = (ctx, register) => {
	register("permission:set-mode", async (data) => {
		const sessionId = guardAgentId(data.agentId, "agentId");
		const mode = guardEnum(data.mode, "mode", ["always", "ask", "plan"] as const) as PermissionMode;
		await ctx.session.permission.applyMode(sessionId, mode, { internal: false, updateDefault: true });
		return { success: true, mode };
	});

	register("permission:get-mode", async (data) => {
		const sessionId = guardAgentId(data.agentId, "agentId");
		return { success: true, mode: ctx.permission.service.getMode(sessionId) };
	});

	register("permission:respond", async (data) => {
		const payload = guardObject(data.payload, "payload");
		const requestId = guardString(payload.requestId, "payload.requestId");
		const action = guardEnum(payload.action, "payload.action", ["allow", "deny", "allow_always"] as const);
		const accepted = ctx.permission.service.handleResponse({ requestId, action });
		return { success: accepted, error: accepted ? undefined : "Permission request is no longer pending" };
	});

	register("plan:question-respond", async (data) => {
		const payload = guardObject(data.payload, "payload");
		const requestId = guardString(payload.requestId, "payload.requestId");
		const sessionId = guardAgentId(payload.sessionId, "payload.sessionId");
		const rawAnswers = guardObject(payload.answers, "payload.answers");
		const answers: Record<string, string> = Object.create(null);
		for (const [question, answer] of Object.entries(rawAnswers)) {
			answers[question] = guardString(answer, `payload.answers[${JSON.stringify(question)}]`);
		}
		const accepted = ctx.permission.plan.handleQuestionResponse({ requestId, sessionId, answers });
		return {
			success: accepted,
			error: accepted ? undefined : "Plan question request is no longer pending or invalid",
		};
	});

	register("plan:approval-respond", async (data) => {
		const payload = guardObject(data.payload, "payload");
		const requestId = guardString(payload.requestId, "payload.requestId");
		const sessionId = guardAgentId(payload.sessionId, "payload.sessionId");
		const action = guardEnum(payload.action, "payload.action", ["approve", "reject"] as const);
		const accepted = await ctx.permission.plan.handleApprovalResponse({ requestId, sessionId, action });
		return { success: accepted, error: accepted ? undefined : "Plan approval request is no longer pending" };
	});
};
