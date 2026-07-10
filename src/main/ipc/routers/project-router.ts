// ============================================================
// Project router — project CRUD and trust prompts
// ============================================================

import { guardBoolean, guardOptionalString, guardPath, guardString } from "../guards.js";
import { promptForProjectTrust } from "../project-trust.js";
import type { IpcRouter } from "../invoke-context.js";

export const projectRouter: IpcRouter = (ctx, register) => {
	register("project:list", async () => {
		const projects = ctx.runtimeManager.listProjects();
		const activeProject = ctx.runtimeManager.getActiveProject();
		return { success: true, projects, activeProjectId: activeProject?.id ?? null };
	});

	register("project:create", async (data) => {
		const _cwd = guardPath(data.cwd, "cwd");
		guardOptionalString(data.name, "name");
		const result = await ctx.runtimeManager.createProject(_cwd, data.name);
		await promptForProjectTrust(ctx.runtimeManager, result.project.id, ctx.mainWindow);
		return {
			success: true,
			project: result.project,
			isDuplicate: result.isDuplicate,
		};
	});

	register("project:switch", async (data) => {
		guardString(data.projectId, "projectId");
		await promptForProjectTrust(ctx.runtimeManager, data.projectId, ctx.mainWindow);
		await ctx.runtimeManager.setActiveProject(data.projectId);
		const agents = ctx.runtimeManager.listAgentsInProject(data.projectId);
		return { success: true, agents };
	});

	register("project:rename", async (data) => {
		guardString(data.projectId, "projectId");
		guardString(data.name, "name");
		ctx.runtimeManager.renameProject(data.projectId, data.name);
		return { success: true };
	});

	register("project:delete", async (data) => {
		guardString(data.projectId, "projectId");
		await ctx.runtimeManager.deleteProject(data.projectId);
		return { success: true };
	});

	register("project:confirm-delete-response", async (data) => {
		guardString(data.projectId, "projectId");
		guardBoolean(data.confirmed, "confirmed");
		if (data.confirmed) {
			await ctx.runtimeManager.executeDeleteProject(data.projectId);
		}
		return { success: true };
	});

	register("project:get-active", async () => {
		const active = ctx.runtimeManager.getActiveProject();
		return { success: true, project: active };
	});
};
