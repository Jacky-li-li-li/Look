// ============================================================
// System router — dialogs, shell, updates, user profile, usage
// ============================================================

import { dialog } from "electron";
import { checkForUpdates, downloadUpdate, quitAndInstall } from "../../system/updater.js";
import { getUsage } from "../../system/usage-service.js";
import { getUserProfile, resetUserProfile, updateUserProfile } from "../../system/user-profile.js";
import { guardObject, guardOptionalBoolean, guardOptionalString, guardPath } from "../guards.js";
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
			return { success: false, canceled: true };
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
			return { success: false, canceled: true };
		}
		return { success: true, paths: result.filePaths };
	});

	register("shell:reveal-in-finder", async (data) => {
		const _path = guardPath(data.path, "path");
		const { shell } = await import("electron");
		shell.showItemInFolder(_path);
		return { success: true };
	});

	register("shell:open-project-folder", async (data) => {
		const { shell } = await import("electron");
		const project = data.projectId
			? ctx.projectService.listProjects().find((item) => item.id === data.projectId)
			: ctx.projectService.getActiveProject();
		if (!project?.valid) throw new Error("Project folder is unavailable");
		await shell.openPath(project.cwd);
		return { success: true, path: project.cwd };
	});

	register("update:check", async () => {
		checkForUpdates().catch((err) => console.warn("[system-router] checkForUpdates failed:", err));
		return { success: true };
	});

	register("update:download", async () => {
		downloadUpdate().catch((err) => console.warn("[system-router] downloadUpdate failed:", err));
		return { success: true };
	});

	register("update:install", async () => {
		quitAndInstall();
		return { success: true };
	});

	register("user-profile:get", async () => {
		return { success: true, profile: getUserProfile() };
	});

	register("user-profile:update", async (data) => {
		guardObject(data.patch, "patch");
		const profile = updateUserProfile(data.patch);
		return { success: true, profile };
	});

	register("user-profile:reset", async () => {
		const profile = resetUserProfile();
		return { success: true, profile };
	});

	register("user-profile:logout", async () => {
		resetUserProfile();
		return { success: true };
	});

	register("usage:get", async () => {
		const usage = await getUsage(ctx.projectService.listProjects());
		return { success: true, usage };
	});
};
