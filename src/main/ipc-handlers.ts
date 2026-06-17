// ============================================================
// IPC Handlers
// Bridges Electron IPC between renderer and AgentManager
// ============================================================

import { type BrowserWindow, dialog, ipcMain } from "electron";
import type { AgentManager } from "./agent-manager.js";
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
import { getSessionsDir } from "./shared/look-storage.js";
import type { MainToRendererEvent, RendererToMainEvent, ThinkingLevel } from "./shared/types.js";
import { checkForUpdates, downloadUpdate, quitAndInstall } from "./updater.js";
import { getUserProfile, resetUserProfile, updateUserProfile } from "./user-profile-service.js";

export function registerIpcHandlers(agentManager: AgentManager, mainWindow: BrowserWindow): void {
	// Clean up previous registrations to support macOS activate re-creation
	ipcMain.removeHandler("look:invoke");
	ipcMain.removeAllListeners("look:event");

	// Forward all AgentManager events to the renderer
	const unsubscribeEvents = agentManager.onEvent((event: MainToRendererEvent) => {
		if (!mainWindow.isDestroyed()) {
			mainWindow.webContents.send("look:event", event);
		}
	});

	mainWindow.on("closed", () => {
		unsubscribeEvents();
	});

	// Handle renderer → main events
	ipcMain.on("look:event", (_event, data: RendererToMainEvent) => {
		handleRendererEvent(data, agentManager);
	});

	// Handle renderer → main invocations (request-response)
	ipcMain.handle("look:invoke", async (_event, data: RendererToMainEvent) => {
		try {
			return await handleRendererInvoke(data, agentManager, mainWindow);
		} catch (err: any) {
			return { success: false, error: err?.message ?? String(err) };
		}
	});
}

function handleRendererEvent(data: RendererToMainEvent, _agentManager: AgentManager): void {
	switch (data.type) {
		case "app:ready":
			break;
	}
}

async function handleRendererInvoke(
	data: RendererToMainEvent,
	agentManager: AgentManager,
	mainWindow: BrowserWindow,
): Promise<any> {
	switch (data.type) {
		// === Agent messaging ===
		case "agent:send-message": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			guardString(data.message, "message");
			guardOptionalString(data.targetAgentId, "targetAgentId");
			await agentManager.sendMessage(_agentId, data.message);
			return { success: true };
		}

		// === Agent lifecycle ===
		case "agent:create": {
			guardOptionalString(data.name, "name");
			const id = await agentManager.createAgent(data.name);
			return { success: true, agentId: id };
		}

		case "agent:destroy": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			await agentManager.destroyAgent(_agentId);
			return { success: true };
		}

		// === Stop / Abort ===
		// P2-2: lets the renderer surface a Stop button that calls
		// `m.session.abort()`. The agent's status naturally rolls back
		// to "idle" via the SDK's own event stream — we don't set
		// status here. Safe to call when not streaming (no-op).
		case "agent:abort": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			await agentManager.abortAgent(_agentId);
			return { success: true };
		}

		// === Model switching ===
		case "agent:switch-model": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			guardString(data.model, "model");
			try {
				await agentManager.setModel(_agentId, data.model);
				return { success: true };
			} catch (e: any) {
				return { success: false, error: e?.message ?? "Failed to switch model" };
			}
		}

		// === Thinking level ===
		case "agent:update-thinking": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			const _level = guardEnum(data.level, "level", ["off", "minimal", "low", "medium", "high", "xhigh"] as const);
			agentManager.setThinkingLevel(_agentId, _level as ThinkingLevel);
			return { success: true };
		}

		// === Model discovery ===
		case "model:list": {
			const models = await agentManager.getAvailableModels();
			return { success: true, models };
		}

		case "model:providers": {
			const providers = await agentManager.getProviders();
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
			const snapshot = agentManager.listAgentsWithHistory();
			return { success: true, agents: snapshot.agents, history: snapshot.history };
		}

		// === Agent history (pull messages for an agent, on demand) ===
		case "agent:get-history": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			const msgs = agentManager.getMessages(_agentId);
			return { success: true, messages: msgs };
		}

		// === Settings ===
		case "settings:get": {
			const providers = await agentManager.getProviderSettings();
			return { success: true, providers };
		}

		case "settings:get-api-key": {
			const _provider = guardProvider(data.provider);
			const key = agentManager.getApiKey(_provider);
			return { success: true, key: key ?? null };
		}

		case "settings:set-api-key": {
			const _provider = guardProvider(data.provider);
			guardString(data.key, "key");
			agentManager.setApiKey(_provider, data.key);
			const providers = await agentManager.getProviderSettings();
			return { success: true, providers };
		}

		case "settings:test-api-key": {
			const _provider = guardProvider(data.provider);
			guardString(data.key, "key");
			const result = await agentManager.testApiKey(_provider, data.key);
			return { success: true, result };
		}

		case "settings:test-env-key": {
			const _provider = guardProvider(data.provider);
			const result = await agentManager.testEnvKey(_provider);
			return { success: true, result };
		}

		case "settings:general:get": {
			return { success: true, settings: agentManager.getGeneralSettings() };
		}

		case "settings:general:set": {
			const settings = guardObject(data.settings, "settings");
			if ("language" in settings) {
				guardEnum(settings.language, "settings.language", ["en", "zh", "ja"] as const);
			}
			if ("defaultThinkingLevel" in settings) {
				guardEnum(settings.defaultThinkingLevel, "settings.defaultThinkingLevel", [
					"off",
					"minimal",
					"low",
					"medium",
					"high",
					"xhigh",
				] as const);
			}
			if ("autoCollapse" in settings) {
				guardBoolean(settings.autoCollapse, "settings.autoCollapse");
			}
			if ("compactionEnabled" in settings) {
				guardBoolean(settings.compactionEnabled, "settings.compactionEnabled");
			}
			if ("preferredModel" in settings && settings.preferredModel !== null) {
				guardString(settings.preferredModel, "settings.preferredModel");
			}
			if ("chatSystemPrompt" in settings) {
				guardString(settings.chatSystemPrompt, "settings.chatSystemPrompt");
			}
			const updated = await agentManager.updateGeneralSettings(data.settings ?? {});
			return { success: true, settings: updated };
		}

		case "settings:general:reset": {
			return { success: true, settings: await agentManager.resetGeneralSettings() };
		}

		// === Context usage & compression ===
		case "context:usage": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			const usage = agentManager.getContextUsage(_agentId);
			return { success: true, usage };
		}

		case "session:compress": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			await agentManager.compressSession(_agentId);
			return { success: true };
		}

		case "agent:rename": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			guardOptionalString(data.name, "name");
			agentManager.renameAgent(_agentId, data.name);
			return { success: true };
		}

		// === Permission ===
		case "permission:response": {
			// The user just made a decision in the permission dialog. We
			// resolve the matching pending ask (if any). The `tool_call`
			// extension hook is awaiting on this resolution — pi's tool
			// execution is suspended until we resolve.
			const action = guardEnum(data.action, "action", ["allow", "deny", "edit"] as const);
			const requestId = guardString(data.requestId, "requestId");
			const askService = agentManager.getPermissionAsk();
			if (action === "deny") {
				askService.resolve(requestId, { action: "deny", reason: data.reason ?? "Denied by user" });
			} else if (action === "edit") {
				askService.resolve(requestId, { action: "edit", args: data.args ?? {} });
			} else {
				askService.resolve(requestId, { action: "allow" });
			}
			console.log(`[Look] Permission ${action} for request ${requestId}`);
			return { success: true, requestId, action };
		}

		case "permission:set-mode": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			const _mode = guardEnum(data.mode, "mode", ["ask", "plan", "allow"] as const);
			agentManager.setPermissionMode(_agentId, _mode);
			return { success: true, mode: _mode };
		}

		// === v0.3 Skills ===
		// Powers the renderer's `/skill:name` slash menu and the
		// "Import from Claude / Cursor / Codex / Copilot" affordance.
		case "skills:list": {
			return { success: true, ...agentManager.listSkillsForUI() };
		}

		case "skills:invoke": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			guardString(data.skillName, "skillName");
			guardOptionalString(data.args, "args");
			return await agentManager.invokeSkill(_agentId, data.skillName, data.args);
		}

		case "skills:import-paths": {
			guardStringArray(data.paths, "paths");
			return await agentManager.importSkillPaths(data.paths);
		}

		case "skills:detect-common": {
			return { success: true, detected: agentManager.detectCommonSkillPaths() };
		}

		// === OS native dialogs ===
		// Wraps `dialog.showOpenDialog` so the renderer (in sandbox)
		// can prompt the user to pick a skills directory. Returns
		// `{ success, path?, canceled }` so callers can distinguish
		// "user pressed Cancel" from "no window available".
		case "dialog:open-directory": {
			if (mainWindow.isDestroyed()) {
				return { success: false, canceled: true, error: "Main window unavailable" };
			}
			const result = await dialog.showOpenDialog(mainWindow, {
				title: "Select a skills directory",
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
			const sessionsDir = getSessionsDir();
			shell.openPath(sessionsDir);
			return { success: true, path: sessionsDir };
		}

		// === Project management ===
		case "project:list": {
			const projects = agentManager.listProjects();
			const activeProject = agentManager.getActiveProject();
			return { success: true, projects, activeProjectId: activeProject?.id ?? null };
		}

		case "project:create": {
			const _cwd = guardPath(data.cwd, "cwd");
			guardOptionalString(data.name, "name");
			const result = agentManager.createProject(_cwd, data.name);
			return {
				success: true,
				project: result.project,
				isDuplicate: result.isDuplicate,
			};
		}

		case "project:switch": {
			guardString(data.projectId, "projectId");
			agentManager.setActiveProject(data.projectId);
			// After switching, return the agents for this project
			const snapshot = agentManager.listAgentsWithHistory();
			return { success: true, agents: snapshot.agents, history: snapshot.history };
		}

		case "project:delete": {
			guardString(data.projectId, "projectId");
			await agentManager.deleteProject(data.projectId);
			return { success: true };
		}

		case "project:confirm-delete-response": {
			guardString(data.projectId, "projectId");
			guardBoolean(data.confirmed, "confirmed");
			if (data.confirmed) {
				await (agentManager as any).executeDeleteProject(data.projectId);
			}
			return { success: true };
		}

		case "project:get-active": {
			const active = agentManager.getActiveProject();
			return { success: true, project: active };
		}

		// === v0.4 Session tree / branching ===
		// `/tree` + `/fork` family. See agent-manager.ts for the
		// pi-side wrappers (getSessionTree / navigateTreeSession /
		// createForkedSession / setEntryLabel). The renderer
		// drives UX around these primitives; main is a thin facade.
		case "agent:get-session-tree": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			const tree = agentManager.getSessionTree(_agentId);
			return { success: true, tree };
		}

		case "agent:get-fork-points": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			const points = agentManager.getForkPoints(_agentId);
			return { success: true, points };
		}

		case "agent:navigate-tree": {
			const _agentId = guardAgentId(data.agentId, "agentId");
			const _entryId = guardString(data.entryId, "entryId");
			guardOptionalBoolean(data.summarize, "summarize");
			guardOptionalString(data.customInstructions, "customInstructions");
			guardOptionalString(data.label, "label");
			try {
				const result = await agentManager.navigateTreeSession(_agentId, _entryId, {
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
				const result = await agentManager.createForkedSession(_agentId, _entryId, {
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
			agentManager.setEntryLabel(_agentId, _entryId, data.label);
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
			const servers = agentManager.getMcpManager().getServerStatuses();
			return { success: true, servers };
		}

		case "mcp:add-server": {
			guardString(data.name, "name");
			const config = guardObject(data.config, "config");
			await agentManager.getMcpManager().addServer(data.name, config as any);
			return { success: true };
		}

		case "mcp:remove-server": {
			guardString(data.name, "name");
			await agentManager.getMcpManager().removeServer(data.name);
			return { success: true };
		}

		case "mcp:restart-server": {
			guardString(data.name, "name");
			await agentManager.getMcpManager().restartServer(data.name);
			return { success: true };
		}

		case "mcp:list-tools": {
			const mgr = agentManager.getMcpManager();
			// Auto-connect if nothing is connected yet (lazy init).
			if (mgr.listAllTools().length === 0) {
				await mgr.connectAll();
			}
			const tools = mgr.listAllTools();
			return { success: true, tools };
		}

		case "mcp:connect-all": {
			await agentManager.getMcpManager().connectAll();
			return { success: true };
		}

		default:
			return { success: false, error: `Unknown event: ${(data as any).type}` };
	}
}
