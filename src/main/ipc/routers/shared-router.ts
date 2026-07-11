// ============================================================
// Shared area router — project shared file operations
// ============================================================

import { SHARED_MAX_CONTENT_BYTES } from "../../workspace/workspace-file-service.js";
import { guardEnum, guardString, guardStringArray } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const sharedRouter: IpcRouter = (ctx, register) => {
	register("shared:list", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const nodes = await ctx.workspaceFileService.listSharedFiles(projectId);
		return { success: true, nodes };
	});

	register("shared:watch", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		await ctx.workspaceFileService.startWatching(projectId);
		return { success: true };
	});

	register("shared:unwatch", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		await ctx.workspaceFileService.stopWatching(projectId);
		return { success: true };
	});

	register("shared:write", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const relativePath = guardString(data.path, "path");
		guardString(data.content, "content");
		if (Buffer.byteLength(data.content, "utf8") > SHARED_MAX_CONTENT_BYTES) {
			return { success: false, error: `Content too large (max ${SHARED_MAX_CONTENT_BYTES} bytes)` };
		}
		await ctx.workspaceFileService.writeSharedFile(projectId, relativePath, data.content);
		return { success: true };
	});

	register("shared:mkdir", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const relativePath = guardString(data.path, "path");
		await ctx.workspaceFileService.createSharedDir(projectId, relativePath);
		return { success: true };
	});

	register("shared:delete", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const relativePath = guardString(data.path, "path");
		await ctx.workspaceFileService.deleteSharedItem(projectId, relativePath);
		return { success: true };
	});

	register("shared:import", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const sources = guardStringArray(data.sources, "sources");
		await ctx.workspaceFileService.importToShared(projectId, sources, data.targetDir);
		return { success: true };
	});

	register("shared:export", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const paths = guardStringArray(data.paths, "paths");
		const destDir = guardString(data.destDir, "destDir");
		await ctx.workspaceFileService.exportFromShared(projectId, paths, destDir);
		return { success: true };
	});

	register("shared:write-content", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const relativePath = guardString(data.path, "path");
		guardString(data.content, "content");
		const encoding = guardEnum(data.encoding, "encoding", ["base64", "utf8"] as const);
		await ctx.workspaceFileService.writeSharedContent(projectId, relativePath, data.content, encoding);
		return { success: true };
	});
};
