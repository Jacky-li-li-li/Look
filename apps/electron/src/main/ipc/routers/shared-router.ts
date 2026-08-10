// ============================================================
// Shared area router — project shared file operations
// ============================================================

import { SHARED_MAX_CONTENT_BYTES } from "../../workspace/workspace-file-service.js";
import { guardContentString, guardEnum, guardOptionalString, guardString, guardStringArray } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

// 内容字符数上限：IPC 载荷中 UTF-8 多字节 / base64 编码下字符数远小于字节数，
// 取字节上限的 4 倍，保证真实字节校验（Buffer.byteLength）在 service 层先行触发。
const SHARED_CONTENT_MAX_CHARS = SHARED_MAX_CONTENT_BYTES * 4;

export const sharedRouter: IpcRouter = (ctx, register) => {
	const requireProjectId = (value: unknown): string => {
		const projectId = guardString(value, "projectId");
		if (!ctx.project.service.getProjectInfo(projectId)) {
			throw new Error(`Project not found: ${projectId}`);
		}
		return projectId;
	};

	register("shared:list", async (data) => {
		const projectId = requireProjectId(data.projectId);
		const nodes = await ctx.workspace.fileService.listSharedFiles(projectId);
		return { success: true, nodes };
	});

	register("shared:list-children", async (data) => {
		const projectId = requireProjectId(data.projectId);
		const relativePath = guardString(data.relativePath, "relativePath");
		const nodes = await ctx.workspace.fileService.listSharedChildren(projectId, relativePath);
		return { success: true, nodes };
	});

	register("shared:watch", async (data) => {
		const projectId = requireProjectId(data.projectId);
		await ctx.workspace.fileService.startWatching(projectId);
		return { success: true };
	});

	register("shared:unwatch", async (data) => {
		const projectId = requireProjectId(data.projectId);
		await ctx.workspace.fileService.stopWatching(projectId);
		return { success: true };
	});

	register("shared:write", async (data) => {
		const projectId = requireProjectId(data.projectId);
		const relativePath = guardString(data.path, "path");
		guardContentString(data.content, "content", SHARED_CONTENT_MAX_CHARS);
		if (Buffer.byteLength(data.content, "utf8") > SHARED_MAX_CONTENT_BYTES) {
			return { success: false, error: `Content too large (max ${SHARED_MAX_CONTENT_BYTES} bytes)` };
		}
		await ctx.workspace.fileService.writeSharedFile(projectId, relativePath, data.content);
		return { success: true };
	});

	register("shared:mkdir", async (data) => {
		const projectId = requireProjectId(data.projectId);
		const relativePath = guardString(data.path, "path");
		await ctx.workspace.fileService.createSharedDir(projectId, relativePath);
		return { success: true };
	});

	register("shared:delete", async (data) => {
		const projectId = requireProjectId(data.projectId);
		const relativePath = guardString(data.path, "path");
		await ctx.workspace.fileService.deleteSharedItem(projectId, relativePath);
		return { success: true };
	});

	register("shared:import", async (data) => {
		const projectId = requireProjectId(data.projectId);
		const sources = guardStringArray(data.sources, "sources");
		const targetDir = guardOptionalString(data.targetDir, "targetDir");
		await ctx.workspace.fileService.importToShared(projectId, sources, targetDir);
		return { success: true };
	});

	register("shared:export", async (data) => {
		const projectId = requireProjectId(data.projectId);
		const paths = guardStringArray(data.paths, "paths");
		const destDir = guardString(data.destDir, "destDir");
		await ctx.workspace.fileService.exportFromShared(projectId, paths, destDir);
		return { success: true };
	});

	register("shared:write-content", async (data) => {
		const projectId = requireProjectId(data.projectId);
		const relativePath = guardString(data.path, "path");
		guardContentString(data.content, "content", SHARED_CONTENT_MAX_CHARS);
		const encoding = guardEnum(data.encoding ?? "utf8", "encoding", ["base64", "utf8"] as const);
		await ctx.workspace.fileService.writeSharedContent(projectId, relativePath, data.content, encoding);
		return { success: true };
	});
};
