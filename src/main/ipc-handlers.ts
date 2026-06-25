// ============================================================
// IPC Handlers
// Bridges Electron IPC between renderer and the pi session runtime registry.
// ============================================================

import { type BrowserWindow, dialog, ipcMain } from "electron";
import {
	guardAgentId,
	guardBoolean,
	guardEnum,
	guardObject,
	guardOptionalBoolean,
	guardOptionalString,
	guardPath,
	guardProvider,
	guardString,
	guardStringArray,
} from "./ipc-guards.js";
import type { SessionRuntimeManager } from "./session-runtime-manager.js";
import type { MainToRendererEvent, PermissionMode, RendererToMainEvent, ThinkingLevel } from "./shared/types.js";
import { checkForUpdates, downloadUpdate, quitAndInstall } from "./updater.js";
import { getUserProfile, resetUserProfile, updateUserProfile } from "./user-profile-service.js";
import type { WorkspaceFileService } from "./workspace/workspace-file-service.js";

export function registerIpcHandlers(runtimeManager: SessionRuntimeManager, mainWindow: BrowserWindow): void {
	// Clean up previous registrations to support macOS activate re-creation
	ipcMain.removeHandler("look:invoke");
	ipcMain.removeAllListeners("look:event");

	const workspaceFileService = runtimeManager.getWorkspaceFileService();
	// 重建窗口时先清旧 callback,避免 chokidar emit 同时打到新/旧 window(M-7)。
	workspaceFileService.clearEmitCallback();
	workspaceFileService.setEmitCallback((event: MainToRendererEvent) => {
		if (!mainWindow.isDestroyed()) {
			mainWindow.webContents.send("look:event", event);
		}
	});

	// Forward session-scoped runtime events to the renderer.
	const unsubscribeEvents = runtimeManager.onEvent((event: MainToRendererEvent) => {
		if (!mainWindow.isDestroyed()) {
			mainWindow.webContents.send("look:event", event);
		}
	});

	mainWindow.on("closed", () => {
		unsubscribeEvents();
		// workspaceFileService.dispose() 由 SessionRuntimeManager.dispose() 统一处理
	});

	// Handle renderer → main events
	ipcMain.on("look:event", (_event, data: RendererToMainEvent) => {
		handleRendererEvent(data);
	});

	// Handle renderer → main invocations (request-response)
	ipcMain.handle("look:invoke", async (_event, data: RendererToMainEvent) => {
		try {
			return await handleRendererInvoke(data, runtimeManager, mainWindow, workspaceFileService);
		} catch (err: any) {
			return {
				success: false,
				error: err?.message ?? String(err),
				errorCode: (err as NodeJS.ErrnoException)?.code ?? null,
				errorStack: err?.stack ?? null,
			};
		}
	});
}

function handleRendererEvent(data: RendererToMainEvent): void {
	switch (data.type) {
		case "app:ready":
			// 占位事件:渲染端通知主进程已就绪,目前无需特殊处理
			break;
	}
}

async function handleRendererInvoke(
	data: RendererToMainEvent,
	runtimeManager: SessionRuntimeManager,
	mainWindow: BrowserWindow,
	workspaceFileService: WorkspaceFileService,
): Promise<any> {
	switch (data.type) {
		// === Agent messaging ===
		case "agent:send-message": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			guardString(data.message, "message");
			await runtimeManager.sendMessage(_agentId, data.message, data.images);
			return { success: true };
		}

		case "agent:activate": {
			const sessionId = guardAgentId(data.agentId, "agentId");
			const projectId = runtimeManager.getAgentInfo(sessionId)?.projectId;
			if (projectId) await promptForProjectTrust(runtimeManager, projectId, mainWindow);
			await runtimeManager.activateSession(sessionId);
			return { success: true };
		}

		// === Agent lifecycle ===
		case "agent:create": {
			guardOptionalString(data.name, "name");
			guardOptionalString(data.projectId, "projectId");
			const projectId = data.projectId ?? runtimeManager.getActiveProject()?.id;
			if (projectId) await promptForProjectTrust(runtimeManager, projectId, mainWindow);
			const id = await runtimeManager.createAgent({ name: data.name, projectId: data.projectId });
			return { success: true, agentId: id };
		}

		case "agent:destroy": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			await runtimeManager.destroyAgent(_agentId);
			return { success: true };
		}

		// === Stop / Abort ===
		// P2-2: lets the renderer surface a Stop button that calls
		// `m.session.abort()`. The agent's status naturally rolls back
		// to "idle" via the SDK's own event stream — we don't set
		// status here. Safe to call when not streaming (no-op).
		case "agent:abort": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			await runtimeManager.abortAgent(_agentId);
			return { success: true };
		}

		// === Model switching ===
		case "agent:switch-model": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			guardString(data.model, "model");
			try {
				await runtimeManager.setModel(_agentId, data.model);
				return { success: true };
			} catch (e: any) {
				return { success: false, error: e?.message ?? "Failed to switch model" };
			}
		}

		// === Thinking level ===
		case "agent:update-thinking": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			const _level = guardEnum(data.level, "level", ["off", "minimal", "low", "medium", "high", "xhigh"] as const);
			await runtimeManager.setThinkingLevel(_agentId, _level as ThinkingLevel);
			return { success: true };
		}

		// === Model discovery ===
		case "model:list": {
			const models = await runtimeManager.getAvailableModels();
			return { success: true, models };
		}

		case "model:providers": {
			const providers = await runtimeManager.getProviders();
			return { success: true, providers };
		}

		// === Agent discovery (initial state pull) ===
		case "agents:list": {
			return { success: true, agents: runtimeManager.listAgents() };
		}

		// === Settings ===
		case "settings:get": {
			const providers = await runtimeManager.getProviderSettings();
			return { success: true, providers };
		}

		case "settings:get-api-key": {
			const _provider = guardProvider(data.provider);
			const key = runtimeManager.getApiKey(_provider);
			return { success: true, key: key ?? null };
		}

		case "settings:set-api-key": {
			const _provider = guardProvider(data.provider);
			guardString(data.key, "key");
			runtimeManager.setApiKey(_provider, data.key);
			const providers = await runtimeManager.getProviderSettings();
			return { success: true, providers };
		}

		case "settings:test-api-key": {
			const _provider = guardProvider(data.provider);
			guardString(data.key, "key");
			const result = await runtimeManager.testApiKey(_provider, data.key);
			return { success: true, result };
		}

		case "settings:test-env-key": {
			const _provider = guardProvider(data.provider);
			const result = await runtimeManager.testEnvKey(_provider);
			return { success: true, result };
		}

		case "settings:general:get": {
			return { success: true, settings: runtimeManager.getGeneralSettings() };
		}

		case "settings:general:set": {
			const settings = guardObject(data.settings, "settings");
			if ("language" in settings) {
				guardEnum(settings.language, "settings.language", ["en", "zh", "ja"] as const);
			}
			if ("autoCollapse" in settings) {
				guardBoolean(settings.autoCollapse, "settings.autoCollapse");
			}
			if ("compactionEnabled" in settings) {
				guardBoolean(settings.compactionEnabled, "settings.compactionEnabled");
			}
			if ("permissionMode" in settings) {
				guardEnum(settings.permissionMode, "settings.permissionMode", ["always", "ask", "plan"] as const);
			}
			if ("preferredModel" in settings && settings.preferredModel !== null) {
				guardString(settings.preferredModel, "settings.preferredModel");
			}
			if ("lastActiveSessionId" in settings) {
				guardString(settings.lastActiveSessionId, "settings.lastActiveSessionId");
			}
			if ("lastActiveProjectId" in settings) {
				guardString(settings.lastActiveProjectId, "settings.lastActiveProjectId");
			}
			if ("openProjectIds" in settings) {
				guardStringArray(settings.openProjectIds, "settings.openProjectIds");
			}
			if ("openedSessionIds" in settings) {
				guardStringArray(settings.openedSessionIds, "settings.openedSessionIds");
			}
			if ("themeStyle" in settings) {
				guardEnum(settings.themeStyle, "settings.themeStyle", ["ink-wash", "swiss", "bauhaus"] as const);
			}
			if ("themeTone" in settings) {
				guardEnum(settings.themeTone, "settings.themeTone", ["light", "dark"] as const);
			}
			const updated = await runtimeManager.updateGeneralSettings(data.settings ?? {});
			return { success: true, settings: updated };
		}

		case "settings:general:reset": {
			return { success: true, settings: await runtimeManager.resetGeneralSettings() };
		}

		// === Context compression ===
		case "session:compress": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			await runtimeManager.compressSession(_agentId);
			return { success: true };
		}

		case "agent:rename": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			guardOptionalString(data.name, "name");
			runtimeManager.renameAgent(_agentId, data.name);
			return { success: true };
		}

		// === v0.3 Skills ===
		// Powers the renderer's `/skill:name` slash menu and the
		// "Import from Claude / Cursor / Codex / Copilot" affordance.
		case "skills:list": {
			return { success: true, ...runtimeManager.listSkillsForUI() };
		}

		case "skills:import-paths": {
			guardStringArray(data.paths, "paths");
			return await runtimeManager.importSkillPaths(data.paths);
		}

		case "skills:detect-common": {
			return { success: true, detected: runtimeManager.detectCommonSkillPaths() };
		}

		// === OS native dialogs ===
		// Wraps `dialog.showOpenDialog` so the renderer (in sandbox)
		// can prompt the user to pick a skills directory. Returns
		// `{ success, path?, canceled }` so callers can distinguish
		// "user pressed Cancel" from "no window available".
		case "dialog:open-directory": {
			guardOptionalString(data.title, "title");
			if (mainWindow.isDestroyed()) {
				return { success: false, canceled: true, error: "Main window unavailable" };
			}
			const result = await dialog.showOpenDialog(mainWindow, {
				title: data.title || "Select a folder",
				properties: ["openDirectory", "createDirectory"],
			});
			if (result.canceled || result.filePaths.length === 0) {
				return { success: false, canceled: true };
			}
			return { success: true, path: result.filePaths[0] };
		}

		case "dialog:open-files": {
			guardOptionalString(data.title, "title");
			guardOptionalBoolean(data.allowDirectories, "allowDirectories");
			guardOptionalBoolean(data.allowMultiple, "allowMultiple");
			if (mainWindow.isDestroyed()) {
				return { success: false, canceled: true, error: "Main window unavailable" };
			}
			const properties: Array<"openFile" | "openDirectory" | "multiSelections"> = ["openFile"];
			if (data.allowDirectories) properties.push("openDirectory");
			if (data.allowMultiple !== false) properties.push("multiSelections");
			const result = await dialog.showOpenDialog(mainWindow, {
				title: data.title || "Select files",
				properties,
			});
			if (result.canceled || result.filePaths.length === 0) {
				return { success: false, canceled: true };
			}
			return { success: true, paths: result.filePaths };
		}

		// === OS shell ===
		case "shell:reveal-in-finder": {
			const _path = guardPath(data.path, "path");
			const { shell } = await import("electron");
			shell.showItemInFolder(_path);
			return { success: true };
		}

		// Opens the session storage directory (~/.look/sessions/) in the OS
		// file manager (Finder / Explorer). This is where all session .jsonl
		// files for each agent are persisted.
		case "shell:open-project-folder": {
			const { shell } = await import("electron");
			const project = data.projectId
				? runtimeManager.listProjects().find((item) => item.id === data.projectId)
				: runtimeManager.getActiveProject();
			if (!project?.valid) throw new Error("Project folder is unavailable");
			await shell.openPath(project.cwd);
			return { success: true, path: project.cwd };
		}

		// === Project management ===
		case "project:list": {
			const projects = runtimeManager.listProjects();
			const activeProject = runtimeManager.getActiveProject();
			return { success: true, projects, activeProjectId: activeProject?.id ?? null };
		}

		case "project:create": {
			const _cwd = guardPath(data.cwd, "cwd");
			guardOptionalString(data.name, "name");
			const result = await runtimeManager.createProject(_cwd, data.name);
			await promptForProjectTrust(runtimeManager, result.project.id, mainWindow);
			return {
				success: true,
				project: result.project,
				isDuplicate: result.isDuplicate,
			};
		}

		case "project:switch": {
			guardString(data.projectId, "projectId");
			await promptForProjectTrust(runtimeManager, data.projectId, mainWindow);
			await runtimeManager.setActiveProject(data.projectId);
			const agents = runtimeManager.listAgentsInProject(data.projectId);
			return { success: true, agents };
		}

		case "project:rename": {
			guardString(data.projectId, "projectId");
			guardString(data.name, "name");
			runtimeManager.renameProject(data.projectId, data.name);
			return { success: true };
		}

		case "project:delete": {
			guardString(data.projectId, "projectId");
			await runtimeManager.deleteProject(data.projectId);
			return { success: true };
		}

		case "project:confirm-delete-response": {
			guardString(data.projectId, "projectId");
			guardBoolean(data.confirmed, "confirmed");
			if (data.confirmed) {
				await runtimeManager.executeDeleteProject(data.projectId);
			}
			return { success: true };
		}

		case "project:get-active": {
			const active = runtimeManager.getActiveProject();
			return { success: true, project: active };
		}

		// === Session tree navigation and parallel fork ===
		case "agent:navigate-tree": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			const _entryId = guardString(data.entryId, "entryId");
			guardOptionalBoolean(data.summarize, "summarize");
			guardOptionalString(data.customInstructions, "customInstructions");
			guardOptionalString(data.label, "label");
			try {
				const result = await runtimeManager.navigateTreeSession(_agentId, _entryId, {
					summarize: data.summarize,
					customInstructions: data.customInstructions,
					label: data.label,
				});
				return { success: true, result };
			} catch (e: any) {
				return { success: false, error: e?.message ?? "Failed to navigate tree" };
			}
		}

		case "agent:create-fork": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			const _entryId = guardString(data.entryId, "entryId");
			guardOptionalString(data.name, "name");
			try {
				const result = await runtimeManager.createForkedSession(_agentId, _entryId, {
					name: data.name,
				});
				return { success: true, ...result };
			} catch (e: any) {
				return { success: false, error: e?.message ?? "Failed to create fork" };
			}
		}

		case "agent:set-entry-label": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			const _entryId = guardString(data.entryId, "entryId");
			if (data.label !== null) {
				guardString(data.label, "label");
			}
			runtimeManager.setEntryLabel(_agentId, _entryId, data.label);
			return { success: true };
		}

		// === Auto Updater ===
		case "update:check": {
			checkForUpdates().catch(() => {});
			return { success: true };
		}

		case "update:download": {
			downloadUpdate().catch(() => {});
			return { success: true };
		}

		case "update:install": {
			quitAndInstall();
			return { success: true };
		}

		// === User Profile ===
		case "user-profile:get": {
			return { success: true, profile: getUserProfile() };
		}

		case "user-profile:update": {
			guardObject(data.patch, "patch");
			const profile = updateUserProfile(data.patch);
			return { success: true, profile };
		}

		case "user-profile:reset": {
			const profile = resetUserProfile();
			return { success: true, profile };
		}

		// === MCP (Model Context Protocol) ===
		case "mcp:list-servers": {
			const servers = runtimeManager.getMcpManager().getServerStatuses();
			return { success: true, servers };
		}

		case "mcp:add-server": {
			guardString(data.name, "name");
			const config = guardObject(data.config, "config");
			await runtimeManager.getMcpManager().addServer(data.name, config as any);
			return { success: true };
		}

		case "mcp:remove-server": {
			guardString(data.name, "name");
			await runtimeManager.getMcpManager().removeServer(data.name);
			return { success: true };
		}

		case "mcp:restart-server": {
			guardString(data.name, "name");
			await runtimeManager.getMcpManager().restartServer(data.name);
			return { success: true };
		}

		case "mcp:list-tools": {
			const mgr = runtimeManager.getMcpManager();
			// Auto-connect if nothing is connected yet (lazy init).
			if (mgr.listAllTools().length === 0) {
				await mgr.connectAll();
			}
			const tools = mgr.listAllTools();
			return { success: true, tools };
		}

		case "mcp:connect-all": {
			await runtimeManager.getMcpManager().connectAll();
			return { success: true };
		}

		// === Shared area ===
		case "shared:list": {
			const projectId = guardString(data.projectId, "projectId");
			const nodes = await workspaceFileService.listSharedFiles(projectId);
			return { success: true, nodes };
		}
		case "shared:watch": {
			const projectId = guardString(data.projectId, "projectId");
			await workspaceFileService.startWatching(projectId);
			return { success: true };
		}
		case "shared:unwatch": {
			const projectId = guardString(data.projectId, "projectId");
			await workspaceFileService.stopWatching(projectId);
			return { success: true };
		}
		case "shared:write": {
			const projectId = guardString(data.projectId, "projectId");
			const relativePath = guardString(data.path, "path");
			guardString(data.content, "content");
			await workspaceFileService.writeSharedFile(projectId, relativePath, data.content);
			return { success: true };
		}
		case "shared:mkdir": {
			const projectId = guardString(data.projectId, "projectId");
			const relativePath = guardString(data.path, "path");
			await workspaceFileService.createSharedDir(projectId, relativePath);
			return { success: true };
		}
		case "shared:delete": {
			const projectId = guardString(data.projectId, "projectId");
			const relativePath = guardString(data.path, "path");
			await workspaceFileService.deleteSharedItem(projectId, relativePath);
			return { success: true };
		}
		case "shared:import": {
			const projectId = guardString(data.projectId, "projectId");
			const sources = guardStringArray(data.sources, "sources");
			await workspaceFileService.importToShared(projectId, sources, data.targetDir);
			return { success: true };
		}
		case "shared:export": {
			const projectId = guardString(data.projectId, "projectId");
			const paths = guardStringArray(data.paths, "paths");
			const destDir = guardString(data.destDir, "destDir");
			await workspaceFileService.exportFromShared(projectId, paths, destDir);
			return { success: true };
		}
		case "shared:write-content": {
			const projectId = guardString(data.projectId, "projectId");
			const relativePath = guardString(data.path, "path");
			guardString(data.content, "content");
			const encoding = guardEnum(data.encoding, "encoding", ["base64", "utf8"] as const);
			await workspaceFileService.writeSharedContent(projectId, relativePath, data.content, encoding);
			return { success: true };
		}

		// === Permission management ===
		case "permission:set-mode": {
			const sessionId = guardAgentId(data.agentId, "agentId");
			const mode = guardEnum(data.mode, "mode", ["always", "ask", "plan"] as const) as PermissionMode;
			await runtimeManager.setPermissionMode(sessionId, mode);
			return { success: true, mode };
		}

		case "permission:get-mode": {
			const sessionId = guardAgentId(data.agentId, "agentId");
			return { success: true, mode: runtimeManager.getPermissionMode(sessionId) };
		}

		case "permission:respond": {
			const payload = guardObject(data.payload, "payload");
			const requestId = guardString(payload.requestId, "payload.requestId");
			const action = guardEnum(payload.action, "payload.action", ["allow", "deny", "allow_always"] as const);
			const accepted = runtimeManager.handlePermissionResponse({ requestId, action });
			return { success: accepted, error: accepted ? undefined : "Permission request is no longer pending" };
		}

		case "plan:question-respond": {
			const payload = guardObject(data.payload, "payload");
			const requestId = guardString(payload.requestId, "payload.requestId");
			const sessionId = guardAgentId(payload.sessionId, "payload.sessionId");
			const rawAnswers = guardObject(payload.answers, "payload.answers");
			const answers: Record<string, string> = Object.create(null);
			for (const [question, answer] of Object.entries(rawAnswers)) {
				answers[question] = guardString(answer, `payload.answers[${JSON.stringify(question)}]`);
			}
			const accepted = runtimeManager.handlePlanQuestionResponse({ requestId, sessionId, answers });
			return {
				success: accepted,
				error: accepted ? undefined : "Plan question request is no longer pending or invalid",
			};
		}

		case "plan:approval-respond": {
			const payload = guardObject(data.payload, "payload");
			const requestId = guardString(payload.requestId, "payload.requestId");
			const sessionId = guardAgentId(payload.sessionId, "payload.sessionId");
			const action = guardEnum(payload.action, "payload.action", ["approve", "reject"] as const);
			const accepted = await runtimeManager.handlePlanApprovalResponse({ requestId, sessionId, action });
			return { success: accepted, error: accepted ? undefined : "Plan approval request is no longer pending" };
		}

		default:
			return { success: false, error: `Unknown event: ${(data as any).type}` };
	}
}

export async function promptForProjectTrust(
	manager: SessionRuntimeManager,
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
		detail: `${project.cwd}\n\nThis allows pi to load .pi settings and resources, install missing project packages, and execute project extensions.`,
		buttons: ["Trust", "Do Not Trust"],
		defaultId: 1,
		cancelId: 1,
	});
	await manager.setProjectTrust(projectId, result.response === 0);
}
