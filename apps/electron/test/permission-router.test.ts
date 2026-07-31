// ============================================================
// Permission router integration tests
// ============================================================

import { describe, expect, it, vi } from "vitest";
import type { InvokeContext } from "../src/main/ipc/invoke-context.js";
import { permissionRouter } from "../src/main/ipc/routers/permission-router.js";
import { expectGuardError, makeDispatcher, makeMockContext } from "./helpers/ipc-test-helpers.js";

function makePermissionCtx(): InvokeContext {
	const ctx = makeMockContext();
	ctx.session.permission = {
		applyMode: vi.fn().mockResolvedValue(undefined),
	} as never;
	ctx.permission.service = {
		getMode: vi.fn().mockReturnValue("ask"),
		handleResponse: vi.fn(),
	} as never;
	ctx.permission.plan = {
		handleQuestionResponse: vi.fn(),
		handleApprovalResponse: vi.fn(),
	} as never;
	return ctx;
}

describe("permission-router", () => {
	describe("guard rejection paths", () => {
		it("permission:set-mode rejects missing agentId", async () => {
			const { dispatch } = makeDispatcher(permissionRouter, makePermissionCtx());
			// @ts-expect-error: missing agentId
			await expectGuardError(dispatch, { type: "permission:set-mode", mode: "ask" }, "agentId");
		});

		it("permission:respond rejects missing payload", async () => {
			const { dispatch } = makeDispatcher(permissionRouter, makePermissionCtx());
			// @ts-expect-error: missing payload
			await expectGuardError(dispatch, { type: "permission:respond" }, "payload");
		});
	});

	describe("service delegation", () => {
		it("permission:set-mode delegates to session.permission.applyMode", async () => {
			const { dispatch, ctx } = makeDispatcher(permissionRouter, makePermissionCtx());
			const result = (await dispatch({
				type: "permission:set-mode",
				agentId: "test-agent",
				mode: "ask",
			})) as Record<string, unknown>;
			expect(result.success).toBe(true);
			expect(result.mode).toBe("ask");
			expect(ctx.session.permission.applyMode).toHaveBeenCalledWith(
				"test-agent",
				"ask",
				expect.objectContaining({ internal: false }),
			);
		});

		it("permission:get-mode delegates to permission.service.getMode", async () => {
			const { dispatch, ctx } = makeDispatcher(permissionRouter, makePermissionCtx());
			await dispatch({ type: "permission:get-mode", agentId: "test-agent" });
			expect(ctx.permission.service.getMode).toHaveBeenCalledWith("test-agent");
		});
	});

	describe("error propagation", () => {
		it("permission:set-mode returns error when service throws", async () => {
			const { dispatch, ctx } = makeDispatcher(permissionRouter, makePermissionCtx());
			(ctx.session.permission.applyMode as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Invalid mode"));
			await expect(dispatch({ type: "permission:set-mode", agentId: "test-agent", mode: "ask" })).rejects.toThrow(
				"Invalid mode",
			);
		});
	});
});
