// ============================================================
// Workspace tree router — project filesystem browsing and watches
// ============================================================

import { guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const workspaceRouter: IpcRouter = (ctx, register) => {
	register("workspace:list-children", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const project = ctx.runtimeManager.getProjectInfo(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!project.valid) throw new Error(`Project path invalid: ${project.cwd}`);
		const relativePath = guardString(data.relativePath, "relativePath");
		const showHiddenFiles = data.showHiddenFiles === true;
		const nodes = await ctx.workspaceTreeService.listChildren(project.cwd, relativePath, showHiddenFiles);
		return { success: true, nodes };
	});

	register("workspace:stat", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const project = ctx.runtimeManager.getProjectInfo(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const relativePath = guardString(data.relativePath, "relativePath");
		const node = await ctx.workspaceTreeService.statNode(project.cwd, relativePath);
		return { success: true, node };
	});

	register("workspace:watch", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const project = ctx.runtimeManager.getProjectInfo(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const relativePath = guardString(data.relativePath, "relativePath");
		ctx.workspaceTreeService.startWatchDir(projectId, project.cwd, relativePath);
		return { success: true };
	});

	register("workspace:unwatch", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const project = ctx.runtimeManager.getProjectInfo(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const relativePath = guardString(data.relativePath, "relativePath");
		ctx.workspaceTreeService.stopWatchDir(projectId, project.cwd, relativePath);
		return { success: true };
	});
};
