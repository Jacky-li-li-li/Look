// ============================================================
// Project router integration tests
// ============================================================

import { describe, expect, it, vi } from "vitest";
import type { InvokeContext } from "../src/main/ipc/invoke-context.js";
import { projectRouter } from "../src/main/ipc/routers/project-router.js";
import { expectGuardError, makeDispatcher, makeMockContext } from "./helpers/ipc-test-helpers.js";

function makeProjectCtx(): InvokeContext {
	const ctx = makeMockContext();
	ctx.project.application = {
		createProject: vi.fn(),
		switchProject: vi.fn(),
		deleteProject: vi.fn(),
		renameProject: vi.fn(),
	} as never;
	ctx.project.service = {
		listProjects: vi.fn().mockReturnValue([]),
		getActiveProject: vi.fn().mockReturnValue(null),
	} as never;
	return ctx;
}

describe("project-router", () => {
	describe("guard rejection paths", () => {
		it("project:create rejects missing cwd", async () => {
			const { dispatch } = makeDispatcher(projectRouter, makeProjectCtx());
			// @ts-expect-error: missing cwd
			await expectGuardError(dispatch, { type: "project:create" }, "cwd");
		});

		it("project:switch rejects missing projectId", async () => {
			const { dispatch } = makeDispatcher(projectRouter, makeProjectCtx());
			// @ts-expect-error: missing projectId
			await expectGuardError(dispatch, { type: "project:switch" }, "projectId");
		});

		it("project:delete rejects missing projectId", async () => {
			const { dispatch } = makeDispatcher(projectRouter, makeProjectCtx());
			// @ts-expect-error: missing projectId
			await expectGuardError(dispatch, { type: "project:delete" }, "projectId");
		});
	});

	describe("service delegation", () => {
		it("project:create delegates to project.application.createProject", async () => {
			const { dispatch, ctx } = makeDispatcher(projectRouter, makeProjectCtx());
			(ctx.project.application.createProject as ReturnType<typeof vi.fn>).mockResolvedValue({
				project: { id: "new-proj" },
				agents: [],
			});
			const result = (await dispatch({ type: "project:create", cwd: "/test" })) as Record<string, unknown>;
			expect(result.success).toBe(true);
			expect(ctx.project.application.createProject).toHaveBeenCalledWith("/test", undefined);
		});

		it("project:list delegates to project.service.listProjects", async () => {
			const { dispatch, ctx } = makeDispatcher(projectRouter, makeProjectCtx());
			(ctx.project.service.listProjects as ReturnType<typeof vi.fn>).mockReturnValue([{ id: "p1", name: "test" }]);
			(ctx.project.service.getActiveProject as ReturnType<typeof vi.fn>).mockReturnValue({ id: "p1", name: "test" });
			const result = (await dispatch({ type: "project:list" })) as Record<string, unknown>;
			expect(result.success).toBe(true);
			expect(Array.isArray(result.projects)).toBe(true);
			expect(ctx.project.service.listProjects).toHaveBeenCalled();
			expect(ctx.project.service.getActiveProject).toHaveBeenCalled();
		});
	});

	describe("error propagation", () => {
		it("project:create returns error when service throws", async () => {
			const { dispatch, ctx } = makeDispatcher(projectRouter, makeProjectCtx());
			(ctx.project.application.createProject as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("No disk"));
			await expect(dispatch({ type: "project:create", cwd: "/test" })).rejects.toThrow("No disk");
		});
	});
});
