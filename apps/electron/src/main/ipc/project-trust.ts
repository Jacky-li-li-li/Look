// ============================================================
// Project trust prompt — shared by IPC routers without depending
// on the monolithic handlers.ts registration file.
//
// Depends on the narrow IProjectTrustManager interface rather than
// the concrete SessionRuntimeManager class. This follows ISP/DIP:
// the trust prompt only needs three methods, not the ~50-method
// SRT public API.
// ============================================================

import { type BrowserWindow, dialog } from "electron";
import type { IProjectTrustManager } from "../core/contracts.js";

export async function promptForProjectTrust(
	manager: IProjectTrustManager,
	projectId: string,
	mainWindow: BrowserWindow,
): Promise<void> {
	const status = manager.getProjectTrustStatus(projectId);
	if (!status.shouldAsk) return;
	const project = manager.listProjects().find((item) => item.id === projectId);
	if (!project) return;
	const result = await dialog.showMessageBox(mainWindow, {
		type: "warning",
		title: "Trust project folder?",
		message: "Trust project folder?",
		detail: `${project.cwd}\n\nThis allows Look to load project settings and resources, install missing packages, and execute project extensions.`,
		buttons: ["Trust", "Do Not Trust"],
		defaultId: 1,
		cancelId: 1,
	});
	await manager.setProjectTrust(projectId, result.response === 0);
}
