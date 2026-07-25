// ============================================================
// Workspace tree router — project filesystem browsing and watches
// ============================================================

import { guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const workspaceRouter: IpcRouter = (ctx, register) => {
	register("workspace:list-children", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const project = ctx.project.service.getProjectInfo(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!project.valid) throw new Error(`Project path invalid: ${project.cwd}`);
		const relativePath = guardString(data.relativePath, "relativePath");
		const showHiddenFiles = data.showHiddenFiles === true;
		const nodes = await ctx.workspace.treeService.listChildren(project.cwd, relativePath, showHiddenFiles);
		return { success: true, nodes };
	});

	register("workspace:stat", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const project = ctx.project.service.getProjectInfo(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const relativePath = guardString(data.relativePath, "relativePath");
		const node = await ctx.workspace.treeService.statNode(project.cwd, relativePath);
		return { success: true, node };
	});

	register("workspace:watch", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const project = ctx.project.service.getProjectInfo(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const relativePath = guardString(data.relativePath, "relativePath");
		ctx.workspace.treeService.startWatchDir(projectId, project.cwd, relativePath);
		return { success: true };
	});

	register("workspace:unwatch", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		const project = ctx.project.service.getProjectInfo(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const relativePath = guardString(data.relativePath, "relativePath");
		ctx.workspace.treeService.stopWatchDir(projectId, project.cwd, relativePath);
		return { success: true };
	});
};
