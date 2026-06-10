// ============================================================
// IPC Handlers
// Bridges Electron IPC between renderer and AgentManager
// ============================================================

import { type BrowserWindow, dialog, ipcMain } from "electron";
import type { AgentManager } from "./agent-manager.js";
import { getSessionsDir } from "./shared/look-storage.js";
import type { AgentRole, MainToRendererEvent, RendererToMainEvent, ThinkingLevel } from "./shared/types.js";
import { checkForUpdates, downloadUpdate, quitAndInstall } from "./updater.js";
import { getUserProfile, resetUserProfile, updateUserProfile } from "./user-profile-service.js";

export function registerIpcHandlers(agentManager: AgentManager, mainWindow: BrowserWindow): void {
	// Forward all AgentManager events to the renderer
	agentManager.onEvent((event: MainToRendererEvent) => {
		if (!mainWindow.isDestroyed()) {
			mainWindow.webContents.send("look:event", event);
		}
	});

	// Handle renderer → main events
	ipcMain.on("look:event", (_event, data: RendererToMainEvent) => {
		handleRendererEvent(data, agentManager);
	});

	// Handle renderer → main invocations (request-response)
	ipcMain.handle("look:invoke", async (_event, data: RendererToMainEvent) => {
		return handleRendererInvoke(data, agentManager, mainWindow);
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
			await agentManager.sendMessage(data.agentId, data.message);
			return { success: true };
		}

		// === Agent lifecycle ===
		case "agent:create": {
			const id = await agentManager.createAgent({
				name: data.name,
				role: data.role as AgentRole,
				model: data.model,
				thinkingLevel: data.thinkingLevel as ThinkingLevel,
				parentAgentId: data.parentAgentId,
			});
			return { success: true, agentId: id };
		}

		case "agent:destroy": {
			await agentManager.destroyAgent(data.agentId);
			return { success: true };
		}

		// === Stop / Abort ===
		// P2-2: lets the renderer surface a Stop button that calls
		// `m.session.abort()`. The agent's status naturally rolls back
		// to "idle" via the SDK's own event stream — we don't set
		// status here. Safe to call when not streaming (no-op).
		case "agent:abort": {
			await agentManager.abortAgent(data.agentId);
			return { success: true };
		}

		// === Model switching ===
		case "agent:switch-model": {
			try {
				await agentManager.setModel(data.agentId, data.model);
				return { success: true };
			} catch (e: any) {
				return { success: false, error: e?.message ?? "Failed to switch model" };
			}
		}

		// === Thinking level ===
		case "agent:update-thinking": {
			agentManager.setThinkingLevel(data.agentId, data.level as ThinkingLevel);
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
			const msgs = agentManager.getMessages(data.agentId);
			return { success: true, messages: msgs };
		}

		// === Settings ===
		case "settings:get": {
			const providers = await agentManager.getProviderSettings();
			return { success: true, providers };
		}

		case "settings:get-api-key": {
			const key = agentManager.getApiKey(data.provider);
			return { success: true, key: key ?? null };
		}

		case "settings:set-api-key": {
			agentManager.setApiKey(data.provider, data.key);
			const providers = await agentManager.getProviderSettings();
			return { success: true, providers };
		}

		case "settings:test-api-key": {
			const result = await agentManager.testApiKey(data.provider, data.key);
			return { success: true, result };
		}

		case "settings:test-env-key": {
			const result = await agentManager.testEnvKey(data.provider);
			return { success: true, result };
		}

		case "settings:get-verified-env": {
			const envProviders = await agentManager.getVerifiedEnvProviders();
			return { success: true, providers: envProviders };
		}

		case "settings:general:get": {
			return { success: true, settings: agentManager.getGeneralSettings() };
		}

		case "settings:general:set": {
			const settings = await agentManager.updateGeneralSettings(data.settings ?? {});
			return { success: true, settings };
		}

		case "settings:general:reset": {
			return { success: true, settings: await agentManager.resetGeneralSettings() };
		}

		// === Context usage & compression ===
		case "context:usage": {
			const usage = agentManager.getContextUsage(data.agentId);
			return { success: true, usage };
		}

		case "session:compress": {
			await agentManager.compressSession(data.agentId);
			return { success: true };
		}

		case "agent:rename": {
			agentManager.renameAgent(data.agentId, data.name);
			return { success: true };
		}

		// === Permission ===
		case "permission:response": {
			// The user just made a decision in the permission dialog. We
			// resolve the matching pending ask (if any). The `tool_call`
			// extension hook is awaiting on this resolution — pi's tool
			// execution is suspended until we resolve.
			const action = (data as any).action as "allow" | "deny" | "edit";
			const askService = agentManager.getPermissionAsk();
			// We need the requestId; in the new payload it's sent as
			// requestId at top-level for backwards compat with the
			// simple {requestId, allowed} shape from the v1 dialog.
			const requestId = (data as any).requestId;
			if (!requestId) return { success: false, error: "Missing requestId" };
			if (action === "deny") {
				askService.resolve(requestId, { action: "deny", reason: (data as any).reason ?? "Denied by user" });
			} else if (action === "edit") {
				askService.resolve(requestId, { action: "edit", args: (data as any).args ?? {} });
			} else {
				askService.resolve(requestId, { action: "allow" });
			}
			console.log(`[Look] Permission ${action} for request ${requestId}`);
			return { success: true, requestId, action };
		}

		case "permission:set-mode": {
			agentManager.setPermissionMode(data.agentId, data.mode);
			return { success: true, mode: data.mode };
		}

		// === v0.3 Skills ===
		// Powers the renderer's `/skill:name` slash menu and the
		// "Import from Claude / Cursor / Codex / Copilot" affordance.
		case "skills:list": {
			return { success: true, ...agentManager.listSkillsForUI() };
		}

		case "skills:invoke": {
			return await agentManager.invokeSkill(data.agentId, data.skillName, data.args);
		}

		case "skills:import-paths": {
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
			const { shell } = await import("electron");
			shell.showItemInFolder(data.path);
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
			const result = agentManager.createProject(data.cwd, data.name);
			return {
				success: true,
				project: result.project,
				isDuplicate: result.isDuplicate,
			};
		}

		case "project:switch": {
			agentManager.setActiveProject(data.projectId);
			// After switching, return the agents for this project
			const snapshot = agentManager.listAgentsWithHistory();
			return { success: true, agents: snapshot.agents, history: snapshot.history };
		}

		case "project:delete": {
			await agentManager.deleteProject(data.projectId);
			return { success: true };
		}

		case "project:confirm-delete-response": {
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
			const tree = agentManager.getSessionTree(data.agentId);
			return { success: true, tree };
		}

		case "agent:get-fork-points": {
			const points = agentManager.getForkPoints(data.agentId);
			return { success: true, points };
		}

		case "agent:navigate-tree": {
			try {
				const result = await agentManager.navigateTreeSession(data.agentId, data.entryId, {
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
			try {
				const result = await agentManager.createForkedSession(data.agentId, data.entryId, {
					name: data.name,
				});
				return { success: true, ...result };
			} catch (e: any) {
				return { success: false, error: e?.message ?? "Failed to create fork" };
			}
		}

		case "agent:set-entry-label": {
			agentManager.setEntryLabel(data.agentId, data.entryId, data.label);
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
			const profile = updateUserProfile(data.patch);
			return { success: true, profile };
		}

		case "user-profile:reset": {
			const profile = resetUserProfile();
			return { success: true, profile };
		}

		default:
			return { success: false, error: `Unknown event: ${(data as any).type}` };
	}
}
