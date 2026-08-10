// ============================================================
// Shared area router integration tests
// ============================================================

import { describe, expect, it, vi } from "vitest";
import type { InvokeContext } from "../src/main/ipc/invoke-context.js";
import { sharedRouter } from "../src/main/ipc/routers/shared-router.js";
import { makeDispatcher, makeMockContext } from "./helpers/ipc-test-helpers.js";

function makeSharedCtx(projectExists = true): InvokeContext {
	const ctx = makeMockContext();
	ctx.project.service = {
		getProjectInfo: vi.fn(() => (projectExists ? { id: "project-1" } : null)),
	} as never;
	ctx.workspace.fileService = {
		listSharedFiles: vi.fn().mockResolvedValue([]),
		listSharedChildren: vi.fn().mockResolvedValue([]),
		writeSharedFile: vi.fn().mockResolvedValue(undefined),
		writeSharedContent: vi.fn().mockResolvedValue(undefined),
	} as never;
	return ctx;
}

describe("shared-router", () => {
	it("rejects an unknown project before invoking shared storage", async () => {
		const { dispatch, ctx } = makeDispatcher(sharedRouter, makeSharedCtx(false));

		await expect(dispatch({ type: "shared:list", projectId: "../escape" })).rejects.toThrow("Project not found");
		expect(ctx.workspace.fileService.listSharedFiles).not.toHaveBeenCalled();
	});

	it("requires an existing project and delegates child listing with its relative path", async () => {
		const { dispatch, ctx } = makeDispatcher(sharedRouter, makeSharedCtx());
		(ctx.workspace.fileService.listSharedChildren as ReturnType<typeof vi.fn>).mockResolvedValue([
			{ name: "summary.md", path: "reports/summary.md", absolutePath: "/tmp/summary.md", type: "file" },
		]);

		const result = (await dispatch({
			type: "shared:list-children",
			projectId: "project-1",
			relativePath: "reports",
		})) as { success: boolean; nodes?: unknown[] };

		expect(result).toMatchObject({ success: true });
		expect(result.nodes).toHaveLength(1);
		expect(ctx.workspace.fileService.listSharedChildren).toHaveBeenCalledWith("project-1", "reports");
	});

	it("accepts file content beyond the generic 100KB guard and lets the service enforce the byte limit", async () => {
		const { dispatch, ctx } = makeDispatcher(sharedRouter, makeSharedCtx());
		const large = "x".repeat(200 * 1024);

		const result = (await dispatch({
			type: "shared:write",
			projectId: "project-1",
			path: "big.txt",
			content: large,
		})) as { success: boolean };

		expect(result.success).toBe(true);
		expect(ctx.workspace.fileService.writeSharedFile).toHaveBeenCalledWith("project-1", "big.txt", large);
	});

	it("defaults write-content encoding to utf8 when omitted", async () => {
		const { dispatch, ctx } = makeDispatcher(sharedRouter, makeSharedCtx());

		const result = (await dispatch({
			type: "shared:write-content",
			projectId: "project-1",
			path: "note.md",
			content: "hello",
		})) as { success: boolean };

		expect(result.success).toBe(true);
		expect(ctx.workspace.fileService.writeSharedContent).toHaveBeenCalledWith(
			"project-1",
			"note.md",
			"hello",
			"utf8",
		);
	});

	it("rejects non-string file content", async () => {
		const { dispatch } = makeDispatcher(sharedRouter, makeSharedCtx());

		await expect(
			dispatch({ type: "shared:write", projectId: "project-1", path: "huge.txt", content: 123 as never }),
		).rejects.toThrow("expected string");
	});
});
