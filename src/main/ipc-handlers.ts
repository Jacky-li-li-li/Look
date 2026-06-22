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

export function registerIpcHandlers(runtimeManager: SessionRuntimeManager, mainWindow: BrowserWindow): void {
	// Clean up previous registrations to support macOS activate re-creation
	ipcMain.removeHandler("look:invoke");
	ipcMain.removeAllListeners("look:event");

	// Forward session-scoped runtime events to the renderer.
	const unsubscribeEvents = runtimeManager.onEvent((event: MainToRendererEvent) => {
		if (!mainWindow.isDestroyed()) {
			mainWindow.webContents.send("look:event", event);
		}
	});

	mainWindow.on("closed", () => {
		unsubscribeEvents();
	});

	// Handle renderer → main events
	ipcMain.on("look:event", (_event, data: RendererToMainEvent) => {
		handleRendererEvent(data, runtimeManager);
	});

	// Handle renderer → main invocations (request-response)
	ipcMain.handle("look:invoke", async (_event, data: RendererToMainEvent) => {
		try {
			return await handleRendererInvoke(data, runtimeManager, mainWindow);
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

function handleRendererEvent(data: RendererToMainEvent, _agentManager: SessionRuntimeManager): void {
	switch (data.type) {
		case "app:ready":
			break;
	}
}

async function handleRendererInvoke(
	data: RendererToMainEvent,
	runtimeManager: SessionRuntimeManager,
	mainWindow: BrowserWindow,
): Promise<any> {
	switch (data.type) {
		// === Agent messaging ===
		case "agent:send-message": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			guardString(data.message, "message");
			await runtimeManager.sendMessage(_agentId, data.message);
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
			// Snapshot of the current agent list + restored history.
			// Bundling history here eliminates the race where the renderer
			// would otherwise need a separate `agent:get-history` call after
			// mount, which can land before/after `loadPersistedAgents` finishes
			// (the latter fires from `app.whenReady` before any IPC subscriber
			// is registered, so push events from there are dropped).
			const snapshot = runtimeManager.listAgentsWithHistory();
			return { success: true, agents: snapshot.agents, history: snapshot.history };
		}

		// === Agent history (pull messages for an agent, on demand) ===
		case "agent:get-history": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			const msgs = runtimeManager.getMessages(_agentId);
			return { success: true, messages: msgs };
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
			const updated = await runtimeManager.updateGeneralSettings(data.settings ?? {});
			return { success: true, settings: updated };
		}

		case "settings:general:reset": {
			return { success: true, settings: await runtimeManager.resetGeneralSettings() };
		}

		// === Context usage & compression ===
		case "context:usage": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			const usage = runtimeManager.getContextUsage(_agentId);
			return { success: true, usage };
		}

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
			const history = Object.fromEntries(agents.map((agent) => [agent.id, runtimeManager.getMessages(agent.id)]));
			return { success: true, agents, history };
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

		// === v0.4 Session tree / branching ===
		// `/tree` + `/fork` family. See session-runtime-manager.ts for the
		// pi-side wrappers (getSessionTree / navigateTreeSession /
		// createForkedSession / setEntryLabel). The renderer
		// drives UX around these primitives; main is a thin facade.
		case "agent:get-session-tree": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			const tree = runtimeManager.getSessionTree(_agentId);
			return { success: true, tree };
		}

		case "agent:get-fork-points": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			const points = runtimeManager.getForkPoints(_agentId);
			return { success: true, points };
		}

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

		// === Permission management ===
		case "permission:set-mode": {
			const mode = guardEnum(data.mode, "mode", ["always", "ask", "plan"] as const) as PermissionMode;
			await runtimeManager.setPermissionMode(mode);
			return { success: true, mode };
		}

		case "permission:get-mode": {
			return { success: true, mode: runtimeManager.getPermissionMode() };
		}

		case "permission:respond": {
			runtimeManager.handlePermissionResponse(data.payload);
			return { success: true };
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
