// ============================================================
// System router — dialogs, shell, user profile, usage
// ============================================================

import { dialog } from "electron";
import { openOAuthWindow } from "../../system/oauth-window.js";
import { TRAFFIC_LIGHT_X, trafficLightYForCenter } from "../../system/traffic-light.js";
import { getUsage } from "../../system/usage-service.js";
import { getUserProfile, resetUserProfile, updateUserProfile } from "../../system/user-profile.js";
import {
	guardNumber,
	guardObject,
	guardOptionalBoolean,
	guardOptionalString,
	guardPath,
	guardString,
} from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

export const systemRouter: IpcRouter = (ctx, register) => {
	register("dialog:open-directory", async (data) => {
		guardOptionalString(data.title, "title");
		if (ctx.mainWindow.isDestroyed()) {
			return { success: false, canceled: true, error: "Main window unavailable" };
		}
		const result = await dialog.showOpenDialog(ctx.mainWindow, {
			title: data.title || "Select a folder",
			properties: ["openDirectory", "createDirectory"],
		});
		if (result.canceled || result.filePaths.length === 0) {
			// 用户取消是正常业务结果（SDK 风格：业务值返回、错误 throw），
			// 不是失败——IpcResult 失败分支要求 error，取消不能走失败分支。
			return { success: true, canceled: true };
		}
		return { success: true, path: result.filePaths[0] };
	});

	register("dialog:open-files", async (data) => {
		guardOptionalString(data.title, "title");
		guardOptionalBoolean(data.allowDirectories, "allowDirectories");
		guardOptionalBoolean(data.allowMultiple, "allowMultiple");
		if (ctx.mainWindow.isDestroyed()) {
			return { success: false, canceled: true, error: "Main window unavailable" };
		}
		const properties: Array<"openFile" | "openDirectory" | "multiSelections"> = ["openFile"];
		if (data.allowDirectories) properties.push("openDirectory");
		if (data.allowMultiple !== false) properties.push("multiSelections");
		const result = await dialog.showOpenDialog(ctx.mainWindow, {
			title: data.title || "Select files",
			properties,
		});
		if (result.canceled || result.filePaths.length === 0) {
			// 用户取消是正常业务结果，不是失败（见 dialog:open-directory 注释）。
			return { success: true, canceled: true };
		}
		return { success: true, paths: result.filePaths };
	});

	register("shell:reveal-in-finder", async (data) => {
		const _path = guardPath(data.path, "path");
		const { shell } = await import("electron");
		shell.showItemInFolder(_path);
		return { success: true };
	});

	// macOS：渲染端实测顶部栏可视中心(CSS px) → 校正 hiddenInset 红绿灯垂直位置。
	// CSS px 乘 zoomFactor 换算为 pt；非 macOS 无红绿灯，直接忽略。
	register("window:set-traffic-light-center", async (data) => {
		if (process.platform !== "darwin" || ctx.mainWindow.isDestroyed()) return { success: true };
		const centerCssPx = guardNumber(data.centerCssPx, "centerCssPx");
		const zoom = ctx.mainWindow.webContents.zoomFactor || 1;
		ctx.mainWindow.setWindowButtonPosition({
			x: TRAFFIC_LIGHT_X,
			y: trafficLightYForCenter(centerCssPx * zoom),
		});
		return { success: true };
	});

	register("shell:open-project-folder", async (data) => {
		const { shell } = await import("electron");
		const project = data.projectId
			? ctx.project.service.listProjects().find((item) => item.id === data.projectId)
			: ctx.project.service.getActiveProject();
		if (!project?.valid) throw new Error("Project folder is unavailable");
		await shell.openPath(project.cwd);
		return { success: true, path: project.cwd };
	});

	register("user-profile:get", async () => {
		return { success: true, profile: getUserProfile() };
	});

	register("user-profile:update", async (data) => {
		guardObject(data.patch, "patch");
		const profile = updateUserProfile(data.patch);
		return { success: true, profile };
	});

	register("user-profile:logout", async () => {
		resetUserProfile();
		return { success: true };
	});

	register("auth:open-oauth-url", async (data) => {
		guardString(data.url, "url");
		guardString(data.redirectTo, "redirectTo");

		// 授权窗口编排（多路导航回调 + protocol 监听 + 超时）在 system/oauth-window。
		return await openOAuthWindow(data.url, data.redirectTo);
	});

	register("usage:get", async () => {
		const usage = await getUsage(ctx.project.service.listProjects());
		return { success: true, usage };
	});
};
