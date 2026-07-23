// ============================================================
// Project router — project CRUD and trust prompts
// ============================================================

import { DEFAULT_PROJECT_ID } from "@look/shared/types";
import { guardBoolean, guardOptionalString, guardPath, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";
import { promptForProjectTrust } from "../project-trust.js";

export const projectRouter: IpcRouter = (ctx, register) => {
	register("project:list", async () => {
		const projects = ctx.projectService.listProjects();
		const activeProject = ctx.projectService.getActiveProject();
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
		const agents = ctx.sessionInfo.listAgentsInProject(data.projectId);
		return { success: true, agents };
	});

	register("project:rename", async (data) => {
		guardString(data.projectId, "projectId");
		guardString(data.name, "name");
		if (data.projectId === DEFAULT_PROJECT_ID) {
			return { success: false, error: "Cannot rename the default workspace" };
		}
		ctx.runtimeManager.renameProject(data.projectId, data.name);
		return { success: true };
	});

	register("project:delete", async (data) => {
		guardString(data.projectId, "projectId");
		if (data.projectId === DEFAULT_PROJECT_ID) {
			return { success: false, error: "Cannot delete the default workspace" };
		}
		await ctx.runtimeManager.deleteProject(data.projectId);
		return { success: true };
	});

	register("project:confirm-delete-response", async (data) => {
		guardString(data.projectId, "projectId");
		guardBoolean(data.confirmed, "confirmed");
		if (data.confirmed) {
			await ctx.projectDeletion.executeDelete(data.projectId);
		}
		return { success: true };
	});

	register("project:get-active", async () => {
		const active = ctx.projectService.getActiveProject();
		return { success: true, project: active };
	});
};
