// ============================================================
// Shared area router — project shared file operations
// ============================================================

import { SHARED_MAX_CONTENT_BYTES } from "../../workspace/workspace-file-service.js";
import { guardEnum, guardOptionalString, guardString, guardStringArray } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const sharedRouter: IpcRouter = (ctx, register) => {
	register("shared:list", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const nodes = await ctx.workspace.fileService.listSharedFiles(projectId);
		return { success: true, nodes };
	});

	register("shared:watch", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		await ctx.workspace.fileService.startWatching(projectId);
		return { success: true };
	});

	register("shared:unwatch", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		await ctx.workspace.fileService.stopWatching(projectId);
		return { success: true };
	});

	register("shared:write", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const relativePath = guardString(data.path, "path");
		guardString(data.content, "content");
		if (Buffer.byteLength(data.content, "utf8") > SHARED_MAX_CONTENT_BYTES) {
			return { success: false, error: `Content too large (max ${SHARED_MAX_CONTENT_BYTES} bytes)` };
		}
		await ctx.workspace.fileService.writeSharedFile(projectId, relativePath, data.content);
		return { success: true };
	});

	register("shared:mkdir", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const relativePath = guardString(data.path, "path");
		await ctx.workspace.fileService.createSharedDir(projectId, relativePath);
		return { success: true };
	});

	register("shared:delete", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const relativePath = guardString(data.path, "path");
		await ctx.workspace.fileService.deleteSharedItem(projectId, relativePath);
		return { success: true };
	});

	register("shared:import", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const sources = guardStringArray(data.sources, "sources");
		const targetDir = guardOptionalString(data.targetDir, "targetDir");
		await ctx.workspace.fileService.importToShared(projectId, sources, targetDir);
		return { success: true };
	});

	register("shared:export", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const paths = guardStringArray(data.paths, "paths");
		const destDir = guardString(data.destDir, "destDir");
		await ctx.workspace.fileService.exportFromShared(projectId, paths, destDir);
		return { success: true };
	});

	register("shared:write-content", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const relativePath = guardString(data.path, "path");
		guardString(data.content, "content");
		const encoding = guardEnum(data.encoding, "encoding", ["base64", "utf8"] as const);
		await ctx.workspace.fileService.writeSharedContent(projectId, relativePath, data.content, encoding);
		return { success: true };
	});
};
