// ============================================================
// Project router — project CRUD and trust prompts
// ============================================================

import { DEFAULT_PROJECT_ID, type MainToRendererEvent } from "@look/shared/types";
import { guardBoolean, guardOptionalString, guardPath, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";
import { promptForProjectTrust } from "../project-trust.js";

export const projectRouter: IpcRouter = (ctx, register) => {
	register("project:list", async () => {
		// 启动早期（Phase 8 之前）的拉取在此挂起到项目索引加载完成，
		// 避免返回"成功的空列表"让渲染端误判为无项目而闪 Welcome 页。
		await ctx.project.service.whenProjectsLoaded();
		const projects = ctx.project.service.listProjects();
		const activeProject = ctx.project.service.getActiveProject();
		return { success: true, projects, activeProjectId: activeProject?.id ?? null };
	});

	register("project:create", async (data) => {
		const _cwd = guardPath(data.cwd, "cwd");
		guardOptionalString(data.name, "name");
		const result = await ctx.project.application.createProject(_cwd, data.name);
		await promptForProjectTrust(ctx.project.trust, result.project.id, ctx.mainWindow);
		return {
			success: true,
			project: result.project,
			isDuplicate: result.isDuplicate,
		};
	});

	register("project:switch", async (data) => {
		guardString(data.projectId, "projectId");
		await promptForProjectTrust(ctx.project.trust, data.projectId, ctx.mainWindow);
		await ctx.project.application.switchProject(data.projectId);
		const agents = ctx.session.info.listAgentsInProject(data.projectId);
		return { success: true, agents };
	});

	register("project:rename", async (data) => {
		guardString(data.projectId, "projectId");
		guardString(data.name, "name");
		if (data.projectId === DEFAULT_PROJECT_ID) {
			return { success: false, error: "Cannot rename the default workspace" };
		}
		ctx.project.application.renameProject(data.projectId, data.name);
		return { success: true };
	});

	register("project:delete", async (data) => {
		guardString(data.projectId, "projectId");
		if (data.projectId === DEFAULT_PROJECT_ID) {
			return { success: false, error: "Cannot delete the default workspace" };
		}
		ctx.project.application.requestDelete(data.projectId);
		return { success: true };
	});

	register("project:confirm-delete-response", async (data) => {
		const projectId = guardString(data.projectId, "projectId");
		guardBoolean(data.confirmed, "confirmed");
		if (projectId === DEFAULT_PROJECT_ID) {
			return { success: false, error: "Cannot delete the default workspace" };
		}
		if (!ctx.project.service.getProjectInfo(projectId)) {
			throw new Error(`Project not found: ${projectId}`);
		}
		if (data.confirmed) {
			await ctx.project.deletion.executeDelete(projectId);
		}
		return { success: true };
	});

	register("project:get-active", async () => {
		const active = ctx.project.service.getActiveProject();
		return { success: true, project: active };
	});

	register("project:git-info", async (data) => {
		// 与 project:list 一致：等待项目索引加载完成，避免启动早期 getProjectInfo
		// 返回 null 让渲染端状态栏永久空白（effect 不会自动重跑）。
		await ctx.project.service.whenProjectsLoaded();
		const projectId = guardString(data.projectId, "projectId");
		const project = ctx.project.service.getProjectInfo(projectId);
		if (!project?.valid) return { success: true, info: null };
		const info = await ctx.git.service.getRepoInfo(project.cwd);

		// 挂 HEAD watcher：外部切分支/改 remote 时失效缓存并主动推送新信息，
		// 渲染端无需等 30s 轮询即可即时刷新状态栏。
		ctx.git.service.ensureWatcher(project.cwd, () => {
			void ctx.git.service.getRepoInfo(project.cwd).then((fresh) => {
				if (!fresh) return;
				const event: MainToRendererEvent = { type: "project:git-info", projectId, info: fresh };
				try {
					if (!ctx.mainWindow.isDestroyed() && !ctx.mainWindow.webContents.isDestroyed()) {
						ctx.mainWindow.webContents.send("look:event", event);
					}
				} catch {
					// 窗口已关闭，忽略推送失败
				}
			});
		});

		return { success: true, info };
	});

	register("project:git-diff", async (data) => {
		await ctx.project.service.whenProjectsLoaded();
		const projectId = guardString(data.projectId, "projectId");
		const project = ctx.project.service.getProjectInfo(projectId);
		if (!project?.valid) return { success: true, files: [] };
		const files = await ctx.git.service.getDiff(project.cwd);
		return { success: true, files };
	});

	register("project:git-file-head", async (data) => {
		await ctx.project.service.whenProjectsLoaded();
		const projectId = guardString(data.projectId, "projectId");
		const absolutePath = guardString(data.absolutePath, "absolutePath");
		const project = ctx.project.service.getProjectInfo(projectId);
		if (!project?.valid) return { success: true, content: null };
		// 与 git:file-head 共用 getFileHeadAtRepo 统一语义：无变更 → null，HEAD 无此文件 → ""
		const content = await ctx.git.service.getFileHeadAtRepo(project.cwd, absolutePath);
		return { success: true, content };
	});

	register("git:file-head", async (data) => {
		const absolutePath = guardString(data.absolutePath, "absolutePath");
		const result = await ctx.git.service.getFileHeadByAbsolutePath(absolutePath);
		return { success: true, content: result?.oldContent ?? null };
	});
};
