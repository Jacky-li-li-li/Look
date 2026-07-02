// ============================================================
// IPC Handlers
// Bridges Electron IPC between renderer and the pi session runtime registry.
// ============================================================

import { completeSimple, type ProviderResponse } from "@earendil-works/pi-ai/compat";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type BrowserWindow, dialog, ipcMain } from "electron";
import { type CustomProviderInput, toProviderConfig } from "./custom-providers-store.js";
import {
	guardAgentId,
	guardBoolean,
	guardEnum,
	guardNullableString,
	guardObject,
	guardOptionalBoolean,
	guardOptionalString,
	guardPath,
	guardProvider,
	guardString,
	guardStringArray,
} from "./ipc-guards.js";
import type { SessionRuntimeManager } from "./session-runtime-manager.js";
import type {
	AgentDefinitionInput,
	MainToRendererEvent,
	PermissionMode,
	RendererToMainEvent,
	ThinkingLevel,
} from "./shared/types.js";
import { checkForUpdates, downloadUpdate, quitAndInstall } from "./updater.js";
import { getUserProfile, resetUserProfile, updateUserProfile } from "./user-profile-service.js";
import type { WorkspaceFileService } from "./workspace/workspace-file-service.js";
import { SHARED_MAX_CONTENT_BYTES } from "./workspace/workspace-file-service.js";
import type { WorkspaceTreeService } from "./workspace/workspace-tree-service.js";

export function registerIpcHandlers(
	runtimeManager: SessionRuntimeManager,
	mainWindow: BrowserWindow,
	larkChannelManager?: import("./im/lark-channel-manager.js").LarkChannelManager,
	larkBridgeService?: import("./im/lark-bridge-service.js").LarkBridgeService,
): void {
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

	const workspaceTreeService = runtimeManager.getWorkspaceTreeService();
	workspaceTreeService.clearEmitCallback();
	workspaceTreeService.setEmitCallback((event: MainToRendererEvent) => {
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
		// workspaceFileService.dispose() / workspaceTreeService.dispose() 由 SessionRuntimeManager.dispose() 统一处理
	});

	// Handle renderer → main events
	ipcMain.on("look:event", (_event, data: RendererToMainEvent) => {
		handleRendererEvent(data);
	});

	// Handle renderer → main invocations (request-response)
	ipcMain.handle("look:invoke", async (_event, data: RendererToMainEvent) => {
		try {
			return await handleRendererInvoke(
				data,
				runtimeManager,
				mainWindow,
				workspaceFileService,
				workspaceTreeService,
				larkChannelManager,
				larkBridgeService,
			);
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
	workspaceTreeService: WorkspaceTreeService,
	larkChannelManager: import("./im/lark-channel-manager.js").LarkChannelManager | undefined,
	larkBridgeService: import("./im/lark-bridge-service.js").LarkBridgeService | undefined,
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
			const result = await runtimeManager.getProviderSettings();
			return { success: true, ...result };
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
			const result = await runtimeManager.getProviderSettings();
			return { success: true, ...result };
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

		// === Custom provider management ===
		case "settings:add-custom-provider": {
			const input = data.payload as CustomProviderInput;
			runtimeManager.customProviders.add(input);
			return { success: true };
		}

		case "settings:update-custom-provider": {
			const { name, patch } = data.payload as { name: string; patch: Partial<CustomProviderInput> };
			runtimeManager.customProviders.update(name, patch);
			return { success: true };
		}

		case "settings:remove-custom-provider": {
			const { name } = data.payload as { name: string };
			return { success: true, removed: runtimeManager.customProviders.remove(name) };
		}

		case "settings:list-custom-providers": {
			return { success: true, providers: runtimeManager.customProviders.list() };
		}

		case "settings:test-custom-provider": {
			const input = data.payload as CustomProviderInput;
			const memAuth = AuthStorage.inMemory(
				input.apiKey ? { [input.name]: { type: "api_key" as const, key: input.apiKey } } : {},
			);
			const memRegistry = ModelRegistry.create(memAuth);
			try {
				memRegistry.registerProvider(input.name, toProviderConfig(input));
			} catch (e: any) {
				return {
					success: true,
					result: {
						overall: "fail",
						results: [{ modelId: "registration", ok: false, error: e?.message ?? String(e) }],
					},
				};
			}

			const results = await Promise.all(
				input.models.map(async (m) => {
					const start = Date.now();
					try {
						const model = memRegistry.find(input.name, m.id);
						if (!model) {
							return { modelId: m.id, ok: false, error: "model not found in in-memory registry" };
						}
						const auth = await memRegistry.getApiKeyAndHeaders(model);
						if (!auth.ok) {
							return { modelId: m.id, ok: false, error: `auth: ${auth.error}` };
						}
						let status = 0;
						const message = await completeSimple(
							model,
							{ messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
							{
								apiKey: auth.apiKey,
								headers: auth.headers,
								maxTokens: 1,
								timeoutMs: 10_000,
								maxRetries: 0,
								onResponse: (response: ProviderResponse) => {
									status = response.status;
								},
							},
						);
						if (message.stopReason === "error") {
							return { modelId: m.id, ok: false, error: message.errorMessage ?? `HTTP ${status}` };
						}
						return { modelId: m.id, ok: true, latencyMs: Date.now() - start };
					} catch (e: any) {
						return { modelId: m.id, ok: false, error: e?.message ?? String(e) };
					}
				}),
			);
			const overall = results.every((r) => r.ok) ? "ok" : "fail";
			return { success: true, result: { overall, results } };
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
			if ("autoTitleModel" in settings) {
				guardNullableString(settings.autoTitleModel, "settings.autoTitleModel");
			}
			if ("subagentEnabled" in settings) {
				guardBoolean(settings.subagentEnabled, "settings.subagentEnabled");
			}
			if ("enabledAgentDefinitions" in settings) {
				if (settings.enabledAgentDefinitions !== null) {
					guardStringArray(settings.enabledAgentDefinitions, "settings.enabledAgentDefinitions");
				}
			}
			if ("enabledSkills" in settings) {
				if (settings.enabledSkills !== null) {
					guardStringArray(settings.enabledSkills, "settings.enabledSkills");
				}
			}
			const updated = await runtimeManager.updateGeneralSettings(data.settings ?? {});
			return { success: true, settings: updated };
		}

		case "settings:general:reset": {
			return { success: true, settings: await runtimeManager.resetGeneralSettings() };
		}

		// === Custom System Prompts ===
		case "settings:prompts:list": {
			return { success: true, ...runtimeManager.promptStore.list() };
		}

		case "settings:prompts:create": {
			const name = guardString(data.name, "name");
			const content = guardString(data.content, "content");
			const prompt = runtimeManager.promptStore.create(name, content);
			return { success: true, prompt };
		}

		case "settings:prompts:update": {
			const id = guardString(data.id, "id");
			const patch: { name?: string; content?: string } = {};
			if ("name" in data) patch.name = guardString(data.name, "name");
			if ("content" in data) patch.content = guardString(data.content, "content");
			const prompt = runtimeManager.promptStore.update(id, patch);
			if (!prompt) return { success: false, error: "Prompt not found" };
			// 同步使用该 prompt 的所有项目级 SYSTEM.md
			if (patch.content) {
				const projectCwds: Record<string, string> = {};
				for (const p of runtimeManager.listProjects()) {
					if (p.valid) projectCwds[p.id] = p.cwd;
				}
				runtimeManager.promptStore.syncProjectOverridesForPrompt(id, projectCwds);
			}
			return { success: true, prompt };
		}

		case "settings:prompts:delete": {
			const id = guardString(data.id, "id");
			const deleted = runtimeManager.promptStore.delete(id);
			if (!deleted) return { success: false, error: "Cannot delete this prompt" };
			return { success: true };
		}

		case "settings:prompts:set-active": {
			const id = guardString(data.id, "id");
			const ok = runtimeManager.promptStore.setActive(id);
			if (!ok) return { success: false, error: "Prompt not found" };
			return { success: true };
		}

		// === Project-level Prompts ===

		case "settings:project-prompts:list": {
			const projectId = guardString(data.projectId, "projectId");
			return { success: true, ...runtimeManager.promptStore.listProjectPrompts(projectId) };
		}

		case "settings:project-prompts:create": {
			const projectId = guardString(data.projectId, "projectId");
			const name = guardString(data.name, "name");
			const content = guardString(data.content, "content");
			const prompt = runtimeManager.promptStore.createProjectPrompt(projectId, name, content);
			const project = runtimeManager.getProjectInfo(projectId);
			if (project) runtimeManager.promptStore.syncProjectSystemFile(projectId, project.cwd);
			return { success: true, prompt };
		}

		case "settings:project-prompts:update": {
			const projectId = guardString(data.projectId, "projectId");
			const id = guardString(data.id, "id");
			const patch: { name?: string; content?: string } = {};
			if ("name" in data) patch.name = guardString(data.name, "name");
			if ("content" in data) patch.content = guardString(data.content, "content");
			const prompt = runtimeManager.promptStore.updateProjectPrompt(projectId, id, patch);
			if (!prompt) return { success: false, error: "Prompt not found" };
			const project = runtimeManager.getProjectInfo(projectId);
			if (project) runtimeManager.promptStore.syncProjectSystemFile(projectId, project.cwd);
			return { success: true, prompt };
		}

		case "settings:project-prompts:delete": {
			const projectId = guardString(data.projectId, "projectId");
			const id = guardString(data.id, "id");
			const deleted = runtimeManager.promptStore.deleteProjectPrompt(projectId, id);
			if (!deleted) return { success: false, error: "Cannot delete this prompt" };
			const project = runtimeManager.getProjectInfo(projectId);
			if (project) runtimeManager.promptStore.syncProjectSystemFile(projectId, project.cwd);
			return { success: true };
		}

		case "settings:project-prompts:set-active": {
			const projectId = guardString(data.projectId, "projectId");
			const id = guardString(data.id, "id");
			const ok = runtimeManager.promptStore.setProjectActive(projectId, id);
			if (!ok) return { success: false, error: "Prompt not found" };
			const project = runtimeManager.getProjectInfo(projectId);
			if (project) runtimeManager.promptStore.syncProjectSystemFile(projectId, project.cwd);
			return { success: true };
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
			// IPC 入口 size check:防止渲染端提交 1GB+ 字符串 OOM 主进程。
			// service 也会再检查一次(防绕过),这里是提前 reject 省 realpath。
			if (Buffer.byteLength(data.content, "utf8") > SHARED_MAX_CONTENT_BYTES) {
				return { success: false, error: `Content too large (max ${SHARED_MAX_CONTENT_BYTES} bytes)` };
			}
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

		// === Workspace tree (v0.6) ===
		case "workspace:list-children": {
			const projectId = guardString(data.projectId, "projectId");
			const project = runtimeManager.getProjectInfo(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			if (!project.valid) throw new Error(`Project path invalid: ${project.cwd}`);
			const relativePath = guardString(data.relativePath, "relativePath");
			const showHiddenFiles = data.showHiddenFiles === true;
			const nodes = await workspaceTreeService.listChildren(project.cwd, relativePath, showHiddenFiles);
			return { success: true, nodes };
		}
		case "workspace:stat": {
			const projectId = guardString(data.projectId, "projectId");
			const project = runtimeManager.getProjectInfo(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const relativePath = guardString(data.relativePath, "relativePath");
			const node = await workspaceTreeService.statNode(project.cwd, relativePath);
			return { success: true, node };
		}
		case "workspace:watch": {
			const projectId = guardString(data.projectId, "projectId");
			const project = runtimeManager.getProjectInfo(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const relativePath = guardString(data.relativePath, "relativePath");
			workspaceTreeService.startWatchDir(projectId, project.cwd, relativePath);
			return { success: true };
		}
		case "workspace:unwatch": {
			const projectId = guardString(data.projectId, "projectId");
			const project = runtimeManager.getProjectInfo(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const relativePath = guardString(data.relativePath, "relativePath");
			workspaceTreeService.stopWatchDir(projectId, project.cwd, relativePath);
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

		// === SubAgent：子会话关系查询（Stage 4 嵌套） ===
		case "agent:list-subagents": {
			const parentId = guardAgentId(data.parentSessionId, "parentSessionId");
			return { success: true, childSessionIds: runtimeManager.listSubSessions(parentId) };
		}

		case "agent:get-parent-session": {
			const childId = guardAgentId(data.childSessionId, "childSessionId");
			return { success: true, parentSessionId: runtimeManager.getParentSession(childId) };
		}

		// === SubAgent：Agent 开关（Stage 2，应用到所有活动会话 + 持久化为默认） ===
		case "agent:set-subagent-enabled": {
			guardBoolean(data.enabled, "enabled");
			await runtimeManager.setSubagentEnabledGlobal(data.enabled);
			return { success: true, enabled: data.enabled };
		}

		// === SubAgent：Agent 定义 CRUD（Stage 3 广场） ===
		case "agent-definitions:list": {
			return { success: true, agents: runtimeManager.listAgentDefinitions() };
		}

		case "agent-definitions:create": {
			const input = guardAgentDefinitionInput(data.input);
			const agent = runtimeManager.createAgentDefinition(input);
			return { success: true, agent };
		}

		case "agent-definitions:update": {
			guardString(data.name, "name");
			const input = guardAgentDefinitionInput(data.input);
			const agent = runtimeManager.updateAgentDefinition(data.name, input);
			return { success: true, agent };
		}

		case "agent-definitions:delete": {
			guardString(data.name, "name");
			runtimeManager.deleteAgentDefinition(data.name);
			return { success: true };
		}

		case "agent-definitions:install": {
			guardString(data.name, "name");
			const agent = runtimeManager.installAgentDefinition(data.name);
			return { success: true, agent };
		}

		// ---- SubAgent：Agent 定义开关 ----
		case "agent-definitions:set-enabled": {
			guardString(data.name, "name");
			guardBoolean(data.enabled, "enabled");
			await runtimeManager.setAgentDefinitionEnabled(data.name, data.enabled);
			return { success: true };
		}

		// ---- Skills：Skill 开关 ----
		case "skills:set-enabled": {
			guardString(data.name, "name");
			guardBoolean(data.enabled, "enabled");
			await runtimeManager.setSkillEnabled(data.name, data.enabled);
			return { success: true };
		}

		// ---- IM / Feishu channel management ----
		case "im:get-channels": {
			return { success: true, channels: larkChannelManager?.getChannels() ?? [] };
		}

		case "im:connect-feishu": {
			guardOptionalString(data.appName, "appName");
			guardOptionalString(data.description, "description");
			if (!larkChannelManager) {
				return { success: false, error: "Feishu channel manager is not available" };
			}
			return await larkChannelManager.startRegistration({
				appName: data.appName,
				description: data.description,
			});
		}

		case "im:connect-feishu-manual": {
			const appId = guardString(data.appId, "appId");
			const appSecret = guardString(data.appSecret, "appSecret");
			guardOptionalString(data.name, "name");
			if (!larkChannelManager) {
				return { success: false, error: "Feishu channel manager is not available" };
			}
			try {
				await larkChannelManager.connectManual({ appId, appSecret, name: data.name });
				return { success: true };
			} catch (err: any) {
				return { success: false, error: err?.message ?? String(err) };
			}
		}

		case "im:cancel-registration": {
			const registrationId = guardString(data.registrationId, "registrationId");
			larkChannelManager?.cancelRegistration(registrationId);
			return { success: true };
		}

		case "im:disconnect-channel": {
			const _provider = guardString(data.provider, "provider");
			guardOptionalString(data.appId, "appId");
			if (!larkChannelManager) {
				return { success: false, error: "Feishu channel manager is not available" };
			}
			await larkChannelManager.disconnect(_provider, data.appId);
			return { success: true };
		}

		case "im:remove-channel": {
			const _provider = guardString(data.provider, "provider");
			const _appId = guardString(data.appId, "appId");
			if (!larkChannelManager) {
				return { success: false, error: "Feishu channel manager is not available" };
			}
			await larkChannelManager.removeChannel(_provider, _appId);
			return { success: true };
		}

		case "im:reconnect-channel": {
			const _provider = guardString(data.provider, "provider");
			const _appId = guardString(data.appId, "appId");
			if (!larkChannelManager) {
				return { success: false, error: "Feishu channel manager is not available" };
			}
			try {
				await larkChannelManager.reconnect(_provider, _appId);
				return { success: true };
			} catch (err: any) {
				return { success: false, error: err?.message ?? String(err) };
			}
		}
		case "im:send-test-message": {
			const receiveIdType = guardString(data.receiveIdType, "receiveIdType");
			const receiveId = guardString(data.receiveId, "receiveId");
			const text = guardString(data.text, "text");
			if (!larkChannelManager) {
				return { success: false, error: "Feishu channel manager is not available" };
			}
			return await larkChannelManager.sendTestMessage({ receiveIdType, receiveId, text });
		}

		case "im:test-connection": {
			const appId = guardString(data.appId, "appId");
			if (!larkChannelManager) {
				return { success: false, error: "Feishu channel manager is not available" };
			}
			return await larkChannelManager.testConnection(appId);
		}

		case "im:test-connection-direct": {
			const appId = guardString(data.appId, "appId");
			const appSecret = guardString(data.appSecret, "appSecret");
			guardOptionalString(data.name, "name");
			if (!larkChannelManager) {
				return { success: false, error: "Feishu channel manager is not available" };
			}
			return await larkChannelManager.testConnectionDirect(appId, appSecret);
		}

		case "im:update-channel": {
			const appId = guardString(data.appId, "appId");
			guardOptionalString(data.name, "name");
			if (!larkChannelManager) {
				return { success: false, error: "Feishu channel manager is not available" };
			}
			await larkChannelManager.updateChannel(appId, { name: data.name });
			return { success: true };
		}

		// ---- IM Bridge: 绑定管理 / 桥接状态 ----
		case "im:get-bindings": {
			if (!larkBridgeService) {
				return { success: false, error: "LarkBridgeService is not available" };
			}
			return { success: true, bindings: larkBridgeService.getBindings() };
		}

		case "im:remove-binding": {
			const chatId = guardString(data.chatId, "chatId");
			if (!larkBridgeService) {
				return { success: false, error: "LarkBridgeService is not available" };
			}
			larkBridgeService.removeBinding(chatId);
			return { success: true };
		}

		case "im:get-bridge-status": {
			if (!larkBridgeService) {
				return { success: false, error: "LarkBridgeService is not available" };
			}
			return { success: true, ...larkBridgeService.getStatus() };
		}
		default:
			return { success: false, error: `Unknown event: ${(data as any).type}` };
	}
}

/** 校验 Agent 定义输入（Stage 3 广场创建/编辑） */
function guardAgentDefinitionInput(input: unknown): AgentDefinitionInput {
	const obj = guardObject(input, "input");
	const name = guardString(obj.name, "input.name");
	const description = guardString(obj.description, "input.description");
	const systemPrompt = guardString(obj.systemPrompt, "input.systemPrompt");
	const result: AgentDefinitionInput = { name, description, systemPrompt };
	if (obj.title !== undefined) result.title = guardString(obj.title, "input.title");
	if (obj.model !== undefined) result.model = guardString(obj.model, "input.model");
	if (obj.icon !== undefined) result.icon = guardString(obj.icon, "input.icon");
	if (obj.version !== undefined) result.version = guardString(obj.version, "input.version");
	if (obj.author !== undefined) result.author = guardString(obj.author, "input.author");
	if (obj.tools !== undefined) result.tools = guardStringArray(obj.tools, "input.tools");
	if (obj.tags !== undefined) result.tags = guardStringArray(obj.tags, "input.tags");
	return result;
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
