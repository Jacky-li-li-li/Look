// ============================================================
// Agent router integration tests
//
// Verifies: guard rejection paths, service delegation, error propagation.
// ============================================================

import { describe, expect, it, vi } from "vitest";
import type { InvokeContext } from "../src/main/ipc/invoke-context.js";
import { agentRouter } from "../src/main/ipc/routers/agent-router.js";
import { expectGuardError, makeDispatcher, makeMockContext } from "./helpers/ipc-test-helpers.js";

function makeAgentCtx(overrides?: Partial<InvokeContext["session"]>): InvokeContext {
	const ctx = makeMockContext();
	ctx.session.messaging = { sendMessage: vi.fn().mockResolvedValue(undefined) } as never;
	ctx.session.lifecycle = {
		createAgent: vi.fn(),
		destroyAgent: vi.fn(),
	} as never;
	ctx.session.info = {
		getManagedRuntime: vi.fn(),
		getAgentInfo: vi.fn(),
		listAgentsInProject: vi.fn().mockReturnValue([]),
	} as never;
	Object.assign(ctx.session, overrides);
	return ctx;
}

describe("agent-router", () => {
	describe("guard rejection paths", () => {
		it("agent:send-message rejects missing agentId", async () => {
			const { dispatch } = makeDispatcher(agentRouter, makeAgentCtx());
			// @ts-expect-error: intentionally missing agentId
			await expectGuardError(dispatch, { type: "agent:send-message", message: "hello" }, "agentId");
		});

		it("agent:send-message rejects missing message", async () => {
			const { dispatch } = makeDispatcher(agentRouter, makeAgentCtx());
			// @ts-expect-error: intentionally missing message
			await expectGuardError(dispatch, { type: "agent:send-message", agentId: "test-agent" }, "message");
		});

		it("agent:create rejects non-string projectId", async () => {
			const { dispatch } = makeDispatcher(agentRouter, makeAgentCtx());
			// @ts-expect-error: intentionally invalid projectId
			await expectGuardError(dispatch, { type: "agent:create", projectId: 123 }, "projectId");
		});

		it("agent:destroy rejects missing agentId", async () => {
			const { dispatch } = makeDispatcher(agentRouter, makeAgentCtx());
			// @ts-expect-error: intentionally missing agentId
			await expectGuardError(dispatch, { type: "agent:destroy" }, "agentId");
		});

		it("agent:activate rejects missing agentId", async () => {
			const { dispatch } = makeDispatcher(agentRouter, makeAgentCtx());
			// @ts-expect-error: intentionally missing agentId
			await expectGuardError(dispatch, { type: "agent:activate" }, "agentId");
		});
	});

	describe("service delegation", () => {
		it("agent:send-message delegates to session.messaging.sendMessage", async () => {
			const { dispatch, ctx } = makeDispatcher(agentRouter, makeAgentCtx());
			const result = await dispatch({
				type: "agent:send-message",
				agentId: "test-agent",
				message: "hello world",
			});
			expect(result).toEqual({ success: true });
			expect(ctx.session.messaging.sendMessage).toHaveBeenCalledWith(
				"test-agent",
				"hello world",
				undefined,
				undefined,
			);
		});

		it("agent:send-message with steer sendMode", async () => {
			const { dispatch, ctx } = makeDispatcher(agentRouter, makeAgentCtx());
			await dispatch({
				type: "agent:send-message",
				agentId: "test-agent",
				message: "steer me",
				sendMode: "steer",
			});
			expect(ctx.session.messaging.sendMessage).toHaveBeenCalledWith("test-agent", "steer me", undefined, "steer");
		});

		it("agent:send-message with followUp sendMode", async () => {
			const { dispatch, ctx } = makeDispatcher(agentRouter, makeAgentCtx());
			await dispatch({
				type: "agent:send-message",
				agentId: "test-agent",
				message: "follow up",
				sendMode: "followUp",
			});
			expect(ctx.session.messaging.sendMessage).toHaveBeenCalledWith(
				"test-agent",
				"follow up",
				undefined,
				"followUp",
			);
		});

		it("agent:create delegates to session.lifecycle.createAgent", async () => {
			const { dispatch, ctx } = makeDispatcher(agentRouter, makeAgentCtx());
			(ctx.session.lifecycle.createAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
				agentId: "new-agent",
			});
			const result = (await dispatch({
				type: "agent:create",
				name: "my-agent",
				projectId: "proj-1",
			})) as Record<string, unknown>;
			expect(result.success).toBe(true);
			expect(ctx.session.lifecycle.createAgent).toHaveBeenCalledWith(
				expect.objectContaining({ name: "my-agent", projectId: "proj-1" }),
			);
		});

		it("agent:destroy delegates to session.lifecycle.destroyAgent", async () => {
			const { dispatch, ctx } = makeDispatcher(agentRouter, makeAgentCtx());
			await dispatch({ type: "agent:destroy", agentId: "test-agent" });
			expect(ctx.session.lifecycle.destroyAgent).toHaveBeenCalledWith("test-agent");
		});
	});

	describe("error propagation", () => {
		it("agent:send-message returns error when service throws", async () => {
			const { dispatch, ctx } = makeDispatcher(agentRouter, makeAgentCtx());
			(ctx.session.messaging.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("BOOM"));
			await expect(
				dispatch({ type: "agent:send-message", agentId: "test-agent", message: "hello" }),
			).rejects.toThrow("BOOM");
		});

		it("agent:create returns error when service throws", async () => {
			const { dispatch, ctx } = makeDispatcher(agentRouter, makeAgentCtx());
			(ctx.session.lifecycle.createAgent as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error("Creation failed"),
			);
			await expect(dispatch({ type: "agent:create", name: "x", projectId: "p" })).rejects.toThrow("Creation failed");
		});
	});
});
