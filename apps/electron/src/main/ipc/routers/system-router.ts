// ============================================================
// System router — dialogs, shell, user profile, usage
// ============================================================

import { BrowserWindow, dialog } from "electron";
import { safeUrlForLog, setOAuthCallbackListener } from "../../system/oauth-callback.js";
import { getUsage } from "../../system/usage-service.js";
import { getUserProfile, resetUserProfile, updateUserProfile } from "../../system/user-profile.js";
import { guardObject, guardOptionalBoolean, guardOptionalString, guardPath, guardString } from "../guards.js";
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

	register("user-profile:reset", async () => {
		const profile = resetUserProfile();
		return { success: true, profile };
	});

	register("user-profile:logout", async () => {
		resetUserProfile();
		return { success: true };
	});

	register("auth:open-oauth-url", async (data) => {
		guardString(data.url, "url");
		guardString(data.redirectTo, "redirectTo");

		return await new Promise<{ success: boolean; redirectUrl?: string; error?: string }>((resolve) => {
			const authWindow = new BrowserWindow({
				width: 800,
				height: 700,
				title: "Authorize Look",
				autoHideMenuBar: true,
				webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
			});

			let resolved = false;
			let fallbackTimer: NodeJS.Timeout | null = null;
			let lastCandidateUrl: string | null = null;
			const done = (result: { success: boolean; redirectUrl?: string; error?: string }) => {
				if (resolved) return;
				resolved = true;
				if (fallbackTimer) clearTimeout(fallbackTimer);
				clearTimeout(timeoutTimer);
				setOAuthCallbackListener(null);
				if (!authWindow.isDestroyed()) authWindow.destroy();
				resolve(result);
			};

			// Never let the login UI spin forever if the flow gets lost
			// (misconfigured redirect whitelist, network failure, etc.).
			const timeoutTimer = setTimeout(
				() => {
					done({ success: false, error: "Authorization timed out" });
				},
				5 * 60 * 1000,
			);

			const redirectMatcher = (url: string) => url.startsWith(data.redirectTo);
			const hasCredentials = (url: string) => /[?&#](code|access_token|error)=/.test(url);
			// #access_token only ever appears on the final session callback. Match it
			// on any URL so a redirect_to whitelist miss (Supabase falls back to the
			// project Site URL with tokens appended) still completes the login.
			const hasImplicitTokens = (url: string) => url.includes("#access_token=");

			const handleCandidate = (url: string, source: string) => {
				if (!redirectMatcher(url) && !hasImplicitTokens(url)) return;
				console.log(`[OAuth] callback candidate via ${source}: ${safeUrlForLog(url)}`);
				lastCandidateUrl = url;
				if (hasCredentials(url)) {
					done({ success: true, redirectUrl: url });
				} else if (!fallbackTimer) {
					// The protocol handler never sees URL fragments; give the
					// navigation events a beat to deliver the full URL first.
					fallbackTimer = setTimeout(() => {
						if (lastCandidateUrl) done({ success: true, redirectUrl: lastCandidateUrl });
					}, 300);
				}
			};

			// Deterministic backstop: the look:// protocol handler always fires
			// once the window follows the final redirect (no URL fragment).
			setOAuthCallbackListener((url) => handleCandidate(url, "protocol"));
			// HTTP 3xx redirects
			authWindow.webContents.on("will-redirect", (_event, url) => handleCandidate(url, "will-redirect"));
			// Explicit navigations (location.href = ..., etc.)
			authWindow.webContents.on("will-navigate", (_event, url) => handleCandidate(url, "will-navigate"));
			// Navigation completed — catches some JS-based redirects
			authWindow.webContents.on("did-navigate", (_event, url) => handleCandidate(url, "did-navigate"));
			// SPA / hash-based navigation fallback
			authWindow.webContents.on("did-navigate-in-page", (_event, url) =>
				handleCandidate(url, "did-navigate-in-page"),
			);

			// Prevent OAuth provider from opening the callback in an external browser
			authWindow.webContents.setWindowOpenHandler(({ url }) => {
				handleCandidate(url, "window-open");
				return { action: "deny" };
			});

			authWindow.on("closed", () => {
				done({ success: false, error: "Authorization window closed" });
			});

			authWindow.loadURL(data.url);
		});
	});

	register("usage:get", async () => {
		const usage = await getUsage(ctx.project.service.listProjects());
		return { success: true, usage };
	});
};
