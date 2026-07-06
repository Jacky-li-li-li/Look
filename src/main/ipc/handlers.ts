// ============================================================
// IPC Handlers
// Bridges Electron IPC between renderer and the pi session runtime registry.
// ============================================================

import { completeSimple, type ProviderResponse } from "@earendil-works/pi-ai/compat";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type BrowserWindow, dialog, ipcMain } from "electron";
import type { SessionRuntimeManager } from "../session/runtime-manager.js";
import { type CustomProviderInput, toProviderConfig } from "../settings/custom-providers.js";
import type {
	AgentDefinitionInput,
	MainToRendererEvent,
	PermissionMode,
	RendererToMainEvent,
	ThinkingLevel,
} from "../shared/types.js";
import { checkForUpdates, downloadUpdate, quitAndInstall } from "../system/updater.js";
import { getUsage } from "../system/usage.js";
import { getUserProfile, resetUserProfile, updateUserProfile } from "../system/user-profile.js";
import type { WorkspaceFileService } from "../workspace/workspace-file-service.js";
import { SHARED_MAX_CONTENT_BYTES } from "../workspace/workspace-file-service.js";
import type { WorkspaceTreeService } from "../workspace/workspace-tree-service.js";
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
} from "./guards.js";

export function registerIpcHandlers(
	runtimeManager: SessionRuntimeManager,
	mainWindow: BrowserWindow,
	larkChannelManager?: import("../im/lark-channel-manager.js").LarkChannelManager,
	larkBridgeService?: import("../im/lark-bridge-service.js").LarkBridgeService,
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
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
				errorCode: (err as NodeJS.ErrnoException)?.code ?? null,
				errorStack: err instanceof Error ? (err.stack ?? null) : null,
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

type InvokeHandler<T extends RendererToMainEvent["type"] = RendererToMainEvent["type"]> = (
	data: Extract<RendererToMainEvent, { type: T }>,
	ctx: InvokeContext,
) => unknown;

/** Type-safe route map: each key gets its exact data shape via Extract. */
type InvokeRouteMap = Partial<{
	[K in RendererToMainEvent["type"]]: InvokeHandler<K>;
}>;

interface InvokeContext {
	runtimeManager: SessionRuntimeManager;
	mainWindow: BrowserWindow;
	workspaceFileService: WorkspaceFileService;
	workspaceTreeService: WorkspaceTreeService;
	larkChannelManager?: import("../im/lark-channel-manager.js").LarkChannelManager;
	larkBridgeService?: import("../im/lark-bridge-service.js").LarkBridgeService;
	mcpManager: import("../mcp/manager.js").MCPManager;
}

const invokeRouteMap: InvokeRouteMap = {
	"agent:send-message": async (data, ctx) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		guardString(data.message, "message");
		await ctx.runtimeManager.sendMessage(_agentId, data.message, data.images);
		return { success: true };
	},
	"agent:activate": async (data, ctx) => {
		const sessionId = guardAgentId(data.agentId, "agentId");
		const projectId = ctx.runtimeManager.getAgentInfo(sessionId)?.projectId;
		if (projectId) await promptForProjectTrust(ctx.runtimeManager, projectId, ctx.mainWindow);
		await ctx.runtimeManager.activateSession(sessionId);
		return { success: true };
	},
	"agent:create": async (data, ctx) => {
		guardOptionalString(data.name, "name");
		guardOptionalString(data.projectId, "projectId");
		const projectId = data.projectId ?? ctx.runtimeManager.getActiveProject()?.id;
		if (projectId) await promptForProjectTrust(ctx.runtimeManager, projectId, ctx.mainWindow);
		const id = await ctx.runtimeManager.createAgent({ name: data.name, projectId: data.projectId });
		return { success: true, agentId: id };
	},
	"agent:destroy": async (data, ctx) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		await ctx.runtimeManager.destroyAgent(_agentId);
		return { success: true };
	},
	"agent:abort": async (data, ctx) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		await ctx.runtimeManager.abortAgent(_agentId);
		return { success: true };
	},
	"agent:switch-model": async (data, ctx) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		guardString(data.model, "model");
		try {
			await ctx.runtimeManager.setModel(_agentId, data.model);
			return { success: true };
		} catch (e) {
			return { success: false, error: e instanceof Error ? e.message : "Failed to switch model" };
		}
	},
	"agent:update-thinking": async (data, ctx) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		const _level = guardEnum(data.level, "level", ["off", "minimal", "low", "medium", "high", "xhigh"] as const);
		await ctx.runtimeManager.setThinkingLevel(_agentId, _level as ThinkingLevel);
		return { success: true };
	},
	"model:list": async (data, ctx) => {
		const models = await ctx.runtimeManager.getAvailableModels();
		return { success: true, models };
	},
	"model:providers": async (data, ctx) => {
		const providers = await ctx.runtimeManager.getProviders();
		return { success: true, providers };
	},
	"agents:list": async (data, ctx) => {
		return { success: true, agents: ctx.runtimeManager.listAgents() };
	},
	"settings:get": async (data, ctx) => {
		const result = await ctx.runtimeManager.getProviderSettings();
		return { success: true, ...result };
	},
	"settings:get-api-key": async (data, ctx) => {
		const _provider = guardProvider(data.provider);
		const key = ctx.runtimeManager.getApiKey(_provider);
		return { success: true, key: key ?? null };
	},
	"settings:set-api-key": async (data, ctx) => {
		const _provider = guardProvider(data.provider);
		guardString(data.key, "key");
		ctx.runtimeManager.setApiKey(_provider, data.key);
		const result = await ctx.runtimeManager.getProviderSettings();
		return { success: true, ...result };
	},
	"settings:test-api-key": async (data, ctx) => {
		const _provider = guardProvider(data.provider);
		guardString(data.key, "key");
		const result = await ctx.runtimeManager.testApiKey(_provider, data.key);
		return { success: true, result };
	},
	"settings:test-env-key": async (data, ctx) => {
		const _provider = guardProvider(data.provider);
		const result = await ctx.runtimeManager.testEnvKey(_provider);
		return { success: true, result };
	},
	"settings:add-custom-provider": async (data, ctx) => {
		const input = data.payload as CustomProviderInput;
		ctx.runtimeManager.customProviders.add(input);
		return { success: true };
	},
	"settings:update-custom-provider": async (data, ctx) => {
		const { name, patch } = data.payload as { name: string; patch: Partial<CustomProviderInput> };
		ctx.runtimeManager.customProviders.update(name, patch);
		return { success: true };
	},
	"settings:remove-custom-provider": async (data, ctx) => {
		const { name } = data.payload as { name: string };
		return { success: true, removed: ctx.runtimeManager.customProviders.remove(name) };
	},
	"settings:list-custom-providers": async (data, ctx) => {
		return { success: true, providers: ctx.runtimeManager.customProviders.list() };
	},
	"settings:test-custom-provider": async (data, ctx) => {
		const input = data.payload as CustomProviderInput;
		const memAuth = AuthStorage.inMemory(
			input.apiKey ? { [input.name]: { type: "api_key" as const, key: input.apiKey } } : {},
		);
		const memRegistry = ModelRegistry.create(memAuth);
		try {
			memRegistry.registerProvider(input.name, toProviderConfig(input));
		} catch (e) {
			return {
				success: true,
				result: {
					overall: "fail",
					results: [{ modelId: "registration", ok: false, error: e instanceof Error ? e.message : String(e) }],
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
				} catch (e) {
					return { modelId: m.id, ok: false, error: e instanceof Error ? e.message : String(e) };
				}
			}),
		);
		const overall = results.every((r) => r.ok) ? "ok" : "fail";
		return { success: true, result: { overall, results } };
	},
	"settings:general:get": async (data, ctx) => {
		return { success: true, settings: ctx.runtimeManager.getGeneralSettings() };
	},
	"settings:general:set": async (data, ctx) => {
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
		const updated = await ctx.runtimeManager.updateGeneralSettings(data.settings ?? {});
		return { success: true, settings: updated };
	},
	"settings:general:reset": async (data, ctx) => {
		return { success: true, settings: await ctx.runtimeManager.resetGeneralSettings() };
	},
	"settings:prompts:list": async (data, ctx) => {
		return { success: true, ...ctx.runtimeManager.promptStore.list() };
	},
	"settings:prompts:create": async (data, ctx) => {
		const name = guardString(data.name, "name");
		const content = guardString(data.content, "content");
		const prompt = ctx.runtimeManager.promptStore.create(name, content);
		return { success: true, prompt };
	},
	"settings:prompts:update": async (data, ctx) => {
		const id = guardString(data.id, "id");
		const patch: { name?: string; content?: string } = {};
		if ("name" in data) patch.name = guardString(data.name, "name");
		if ("content" in data) patch.content = guardString(data.content, "content");
		const prompt = ctx.runtimeManager.promptStore.update(id, patch);
		if (!prompt) return { success: false, error: "Prompt not found" };
		// 同步使用该 prompt 的所有项目级 SYSTEM.md
		if (patch.content) {
			ctx.runtimeManager.promptStore.syncProjectOverridesForPrompt(id);
		}
		return { success: true, prompt };
	},
	"settings:prompts:delete": async (data, ctx) => {
		const id = guardString(data.id, "id");
		const deleted = ctx.runtimeManager.promptStore.delete(id);
		if (!deleted) return { success: false, error: "Cannot delete this prompt" };
		return { success: true };
	},
	"settings:prompts:set-active": async (data, ctx) => {
		const id = guardString(data.id, "id");
		const ok = ctx.runtimeManager.promptStore.setActive(id);
		if (!ok) return { success: false, error: "Prompt not found" };
		return { success: true };
	},
	"settings:project-prompts:list": async (data, ctx) => {
		const projectId = guardString(data.projectId, "projectId");
		return { success: true, ...ctx.runtimeManager.promptStore.listProjectPrompts(projectId) };
	},
	"settings:project-prompts:create": async (data, ctx) => {
		const projectId = guardString(data.projectId, "projectId");
		const name = guardString(data.name, "name");
		const content = guardString(data.content, "content");
		const prompt = ctx.runtimeManager.promptStore.createProjectPrompt(projectId, name, content);
		ctx.runtimeManager.promptStore.syncProjectSystemFile(projectId);
		return { success: true, prompt };
	},
	"settings:project-prompts:update": async (data, ctx) => {
		const projectId = guardString(data.projectId, "projectId");
		const id = guardString(data.id, "id");
		const patch: { name?: string; content?: string } = {};
		if ("name" in data) patch.name = guardString(data.name, "name");
		if ("content" in data) patch.content = guardString(data.content, "content");
		const prompt = ctx.runtimeManager.promptStore.updateProjectPrompt(projectId, id, patch);
		if (!prompt) return { success: false, error: "Prompt not found" };
		ctx.runtimeManager.promptStore.syncProjectSystemFile(projectId);
		return { success: true, prompt };
	},
	"settings:project-prompts:delete": async (data, ctx) => {
		const projectId = guardString(data.projectId, "projectId");
		const id = guardString(data.id, "id");
		const deleted = ctx.runtimeManager.promptStore.deleteProjectPrompt(projectId, id);
		if (!deleted) return { success: false, error: "Cannot delete this prompt" };
		ctx.runtimeManager.promptStore.syncProjectSystemFile(projectId);
		return { success: true };
	},
	"settings:project-prompts:set-active": async (data, ctx) => {
		const projectId = guardString(data.projectId, "projectId");
		const id = guardString(data.id, "id");
		const ok = ctx.runtimeManager.promptStore.setProjectActive(projectId, id);
		if (!ok) return { success: false, error: "Prompt not found" };
		ctx.runtimeManager.promptStore.syncProjectSystemFile(projectId);
		return { success: true };
	},
	"session:compress": async (data, ctx) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		await ctx.runtimeManager.compressSession(_agentId);
		return { success: true };
	},
	"agent:rename": async (data, ctx) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		guardOptionalString(data.name, "name");
		ctx.runtimeManager.renameAgent(_agentId, data.name);
		return { success: true };
	},
	"skills:list": async (data, ctx) => {
		return { success: true, ...ctx.runtimeManager.listSkillsForUI() };
	},
	"skills:import-paths": async (data, ctx) => {
		guardStringArray(data.paths, "paths");
		return await ctx.runtimeManager.importSkillPaths(data.paths);
	},
	"skills:detect-common": async (data, ctx) => {
		return { success: true, detected: ctx.runtimeManager.detectCommonSkillPaths() };
	},
	"dialog:open-directory": async (data, ctx) => {
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
	},
	"dialog:open-files": async (data, ctx) => {
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
	},
	"shell:reveal-in-finder": async (data, ctx) => {
		const _path = guardPath(data.path, "path");
		const { shell } = await import("electron");
		shell.showItemInFolder(_path);
		return { success: true };
	},
	"shell:open-project-folder": async (data, ctx) => {
		const { shell } = await import("electron");
		const project = data.projectId
			? ctx.runtimeManager.listProjects().find((item) => item.id === data.projectId)
			: ctx.runtimeManager.getActiveProject();
		if (!project?.valid) throw new Error("Project folder is unavailable");
		await shell.openPath(project.cwd);
		return { success: true, path: project.cwd };
	},
	"project:list": async (data, ctx) => {
		const projects = ctx.runtimeManager.listProjects();
		const activeProject = ctx.runtimeManager.getActiveProject();
		return { success: true, projects, activeProjectId: activeProject?.id ?? null };
	},
	"project:create": async (data, ctx) => {
		const _cwd = guardPath(data.cwd, "cwd");
		guardOptionalString(data.name, "name");
		const result = await ctx.runtimeManager.createProject(_cwd, data.name);
		await promptForProjectTrust(ctx.runtimeManager, result.project.id, ctx.mainWindow);
		return {
			success: true,
			project: result.project,
			isDuplicate: result.isDuplicate,
		};
	},
	"project:switch": async (data, ctx) => {
		guardString(data.projectId, "projectId");
		await promptForProjectTrust(ctx.runtimeManager, data.projectId, ctx.mainWindow);
		await ctx.runtimeManager.setActiveProject(data.projectId);
		const agents = ctx.runtimeManager.listAgentsInProject(data.projectId);
		return { success: true, agents };
	},
	"project:rename": async (data, ctx) => {
		guardString(data.projectId, "projectId");
		guardString(data.name, "name");
		ctx.runtimeManager.renameProject(data.projectId, data.name);
		return { success: true };
	},
	"project:delete": async (data, ctx) => {
		guardString(data.projectId, "projectId");
		await ctx.runtimeManager.deleteProject(data.projectId);
		return { success: true };
	},
	"project:confirm-delete-response": async (data, ctx) => {
		guardString(data.projectId, "projectId");
		guardBoolean(data.confirmed, "confirmed");
		if (data.confirmed) {
			await ctx.runtimeManager.executeDeleteProject(data.projectId);
		}
		return { success: true };
	},
	"project:get-active": async (data, ctx) => {
		const active = ctx.runtimeManager.getActiveProject();
		return { success: true, project: active };
	},
	"agent:navigate-tree": async (data, ctx) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		const _entryId = guardString(data.entryId, "entryId");
		guardOptionalBoolean(data.summarize, "summarize");
		guardOptionalString(data.customInstructions, "customInstructions");
		guardOptionalString(data.label, "label");
		try {
			const result = await ctx.runtimeManager.navigateTreeSession(_agentId, _entryId, {
				summarize: data.summarize,
				customInstructions: data.customInstructions,
				label: data.label,
			});
			return { success: true, result };
		} catch (e) {
			return { success: false, error: e instanceof Error ? e.message : "Failed to navigate tree" };
		}
	},
	"agent:create-fork": async (data, ctx) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		const _entryId = guardString(data.entryId, "entryId");
		guardOptionalString(data.name, "name");
		try {
			const result = await ctx.runtimeManager.createForkedSession(_agentId, _entryId, {
				name: data.name,
			});
			return { success: true, ...result };
		} catch (e) {
			return { success: false, error: e instanceof Error ? e.message : "Failed to create fork" };
		}
	},
	"agent:set-entry-label": async (data, ctx) => {
		const _agentId = guardAgentId(data.agentId, "agentId");
		const _entryId = guardString(data.entryId, "entryId");
		if (data.label !== null) {
			guardString(data.label, "label");
		}
		ctx.runtimeManager.setEntryLabel(_agentId, _entryId, data.label);
		return { success: true };
	},
	"update:check": async (data, ctx) => {
		checkForUpdates().catch(() => {});
		return { success: true };
	},
	"update:download": async (data, ctx) => {
		downloadUpdate().catch(() => {});
		return { success: true };
	},
	"update:install": async (data, ctx) => {
		quitAndInstall();
		return { success: true };
	},
	"user-profile:get": async (data, ctx) => {
		return { success: true, profile: getUserProfile() };
	},
	"user-profile:update": async (data, ctx) => {
		guardObject(data.patch, "patch");
		const profile = updateUserProfile(data.patch);
		return { success: true, profile };
	},
	"user-profile:reset": async (data, ctx) => {
		const profile = resetUserProfile();
		return { success: true, profile };
	},
	"usage:get": async (data, ctx) => {
		const usage = await getUsage(ctx.runtimeManager.listProjects());
		return { success: true, usage };
	},
	"shared:list": async (data, ctx) => {
		const projectId = guardString(data.projectId, "projectId");
		const nodes = await ctx.workspaceFileService.listSharedFiles(projectId);
		return { success: true, nodes };
	},
	"shared:watch": async (data, ctx) => {
		const projectId = guardString(data.projectId, "projectId");
		await ctx.workspaceFileService.startWatching(projectId);
		return { success: true };
	},
	"shared:unwatch": async (data, ctx) => {
		const projectId = guardString(data.projectId, "projectId");
		await ctx.workspaceFileService.stopWatching(projectId);
		return { success: true };
	},
	"shared:write": async (data, ctx) => {
		const projectId = guardString(data.projectId, "projectId");
		const relativePath = guardString(data.path, "path");
		guardString(data.content, "content");
		// IPC 入口 size check:防止渲染端提交 1GB+ 字符串 OOM 主进程。
		// service 也会再检查一次(防绕过),这里是提前 reject 省 realpath。
		if (Buffer.byteLength(data.content, "utf8") > SHARED_MAX_CONTENT_BYTES) {
			return { success: false, error: `Content too large (max ${SHARED_MAX_CONTENT_BYTES} bytes)` };
		}
		await ctx.workspaceFileService.writeSharedFile(projectId, relativePath, data.content);
		return { success: true };
	},
	"shared:mkdir": async (data, ctx) => {
		const projectId = guardString(data.projectId, "projectId");
		const relativePath = guardString(data.path, "path");
		await ctx.workspaceFileService.createSharedDir(projectId, relativePath);
		return { success: true };
	},
	"shared:delete": async (data, ctx) => {
		const projectId = guardString(data.projectId, "projectId");
		const relativePath = guardString(data.path, "path");
		await ctx.workspaceFileService.deleteSharedItem(projectId, relativePath);
		return { success: true };
	},
	"shared:import": async (data, ctx) => {
		const projectId = guardString(data.projectId, "projectId");
		const sources = guardStringArray(data.sources, "sources");
		await ctx.workspaceFileService.importToShared(projectId, sources, data.targetDir);
		return { success: true };
	},
	"shared:export": async (data, ctx) => {
		const projectId = guardString(data.projectId, "projectId");
		const paths = guardStringArray(data.paths, "paths");
		const destDir = guardString(data.destDir, "destDir");
		await ctx.workspaceFileService.exportFromShared(projectId, paths, destDir);
		return { success: true };
	},
	"shared:write-content": async (data, ctx) => {
		const projectId = guardString(data.projectId, "projectId");
		const relativePath = guardString(data.path, "path");
		guardString(data.content, "content");
		const encoding = guardEnum(data.encoding, "encoding", ["base64", "utf8"] as const);
		await ctx.workspaceFileService.writeSharedContent(projectId, relativePath, data.content, encoding);
		return { success: true };
	},
	"workspace:list-children": async (data, ctx) => {
		const projectId = guardString(data.projectId, "projectId");
		const project = ctx.runtimeManager.getProjectInfo(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		if (!project.valid) throw new Error(`Project path invalid: ${project.cwd}`);
		const relativePath = guardString(data.relativePath, "relativePath");
		const showHiddenFiles = data.showHiddenFiles === true;
		const nodes = await ctx.workspaceTreeService.listChildren(project.cwd, relativePath, showHiddenFiles);
		return { success: true, nodes };
	},
	"workspace:stat": async (data, ctx) => {
		const projectId = guardString(data.projectId, "projectId");
		const project = ctx.runtimeManager.getProjectInfo(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const relativePath = guardString(data.relativePath, "relativePath");
		const node = await ctx.workspaceTreeService.statNode(project.cwd, relativePath);
		return { success: true, node };
	},
	"workspace:watch": async (data, ctx) => {
		const projectId = guardString(data.projectId, "projectId");
		const project = ctx.runtimeManager.getProjectInfo(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const relativePath = guardString(data.relativePath, "relativePath");
		ctx.workspaceTreeService.startWatchDir(projectId, project.cwd, relativePath);
		return { success: true };
	},
	"workspace:unwatch": async (data, ctx) => {
		const projectId = guardString(data.projectId, "projectId");
		const project = ctx.runtimeManager.getProjectInfo(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const relativePath = guardString(data.relativePath, "relativePath");
		ctx.workspaceTreeService.stopWatchDir(projectId, project.cwd, relativePath);
		return { success: true };
	},
	"permission:set-mode": async (data, ctx) => {
		const sessionId = guardAgentId(data.agentId, "agentId");
		const mode = guardEnum(data.mode, "mode", ["always", "ask", "plan"] as const) as PermissionMode;
		await ctx.runtimeManager.setPermissionMode(sessionId, mode);
		return { success: true, mode };
	},
	"permission:get-mode": async (data, ctx) => {
		const sessionId = guardAgentId(data.agentId, "agentId");
		return { success: true, mode: ctx.runtimeManager.getPermissionMode(sessionId) };
	},
	"permission:respond": async (data, ctx) => {
		const payload = guardObject(data.payload, "payload");
		const requestId = guardString(payload.requestId, "payload.requestId");
		const action = guardEnum(payload.action, "payload.action", ["allow", "deny", "allow_always"] as const);
		const accepted = ctx.runtimeManager.handlePermissionResponse({ requestId, action });
		return { success: accepted, error: accepted ? undefined : "Permission request is no longer pending" };
	},
	"plan:question-respond": async (data, ctx) => {
		const payload = guardObject(data.payload, "payload");
		const requestId = guardString(payload.requestId, "payload.requestId");
		const sessionId = guardAgentId(payload.sessionId, "payload.sessionId");
		const rawAnswers = guardObject(payload.answers, "payload.answers");
		const answers: Record<string, string> = Object.create(null);
		for (const [question, answer] of Object.entries(rawAnswers)) {
			answers[question] = guardString(answer, `payload.answers[${JSON.stringify(question)}]`);
		}
		const accepted = ctx.runtimeManager.handlePlanQuestionResponse({ requestId, sessionId, answers });
		return {
			success: accepted,
			error: accepted ? undefined : "Plan question request is no longer pending or invalid",
		};
	},
	"plan:approval-respond": async (data, ctx) => {
		const payload = guardObject(data.payload, "payload");
		const requestId = guardString(payload.requestId, "payload.requestId");
		const sessionId = guardAgentId(payload.sessionId, "payload.sessionId");
		const action = guardEnum(payload.action, "payload.action", ["approve", "reject"] as const);
		const accepted = await ctx.runtimeManager.handlePlanApprovalResponse({ requestId, sessionId, action });
		return { success: accepted, error: accepted ? undefined : "Plan approval request is no longer pending" };
	},
	"agent:list-subagents": async (data, ctx) => {
		const parentId = guardAgentId(data.parentSessionId, "parentSessionId");
		return { success: true, childSessionIds: ctx.runtimeManager.listSubSessions(parentId) };
	},
	"agent:get-parent-session": async (data, ctx) => {
		const childId = guardAgentId(data.childSessionId, "childSessionId");
		return { success: true, parentSessionId: ctx.runtimeManager.getParentSession(childId) };
	},
	"agent:set-subagent-enabled": async (data, ctx) => {
		guardBoolean(data.enabled, "enabled");
		await ctx.runtimeManager.setSubagentEnabledGlobal(data.enabled);
		return { success: true, enabled: data.enabled };
	},
	"agent-definitions:list": async (data, ctx) => {
		return { success: true, agents: await ctx.runtimeManager.listAgentDefinitions() };
	},
	"agent-definitions:create": async (data, ctx) => {
		const input = guardAgentDefinitionInput(data.input);
		const agent = await ctx.runtimeManager.createAgentDefinition(input);
		return { success: true, agent };
	},
	"agent-definitions:update": async (data, ctx) => {
		guardString(data.name, "name");
		const input = guardAgentDefinitionInput(data.input);
		const agent = await ctx.runtimeManager.updateAgentDefinition(data.name, input);
		return { success: true, agent };
	},
	"agent-definitions:delete": async (data, ctx) => {
		guardString(data.name, "name");
		ctx.runtimeManager.deleteAgentDefinition(data.name);
		return { success: true };
	},
	"agent-definitions:install": async (data, ctx) => {
		guardString(data.name, "name");
		const agent = await ctx.runtimeManager.installAgentDefinition(data.name);
		return { success: true, agent };
	},
	"agent-definitions:set-enabled": async (data, ctx) => {
		guardString(data.name, "name");
		guardBoolean(data.enabled, "enabled");
		await ctx.runtimeManager.setAgentDefinitionEnabled(data.name, data.enabled);
		return { success: true };
	},
	"skills:set-enabled": async (data, ctx) => {
		guardString(data.name, "name");
		guardBoolean(data.enabled, "enabled");
		await ctx.runtimeManager.setSkillEnabled(data.name, data.enabled);
		return { success: true };
	},
	"im:get-channels": async (data, ctx) => {
		return { success: true, channels: ctx.larkChannelManager?.getChannels() ?? [] };
	},
	"im:connect-feishu": async (data, ctx) => {
		guardOptionalString(data.appName, "appName");
		guardOptionalString(data.description, "description");
		if (!ctx.larkChannelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		return await ctx.larkChannelManager.startRegistration({
			appName: data.appName,
			description: data.description,
		});
	},
	"im:connect-feishu-manual": async (data, ctx) => {
		const appId = guardString(data.appId, "appId");
		const appSecret = guardString(data.appSecret, "appSecret");
		guardOptionalString(data.name, "name");
		if (!ctx.larkChannelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		try {
			await ctx.larkChannelManager.connectManual({ appId, appSecret, name: data.name });
			return { success: true };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	},
	"im:cancel-registration": async (data, ctx) => {
		const registrationId = guardString(data.registrationId, "registrationId");
		ctx.larkChannelManager?.cancelRegistration(registrationId);
		return { success: true };
	},
	"im:disconnect-channel": async (data, ctx) => {
		const _provider = guardString(data.provider, "provider");
		guardOptionalString(data.appId, "appId");
		if (!ctx.larkChannelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		await ctx.larkChannelManager.disconnect(_provider, data.appId);
		return { success: true };
	},
	"im:remove-channel": async (data, ctx) => {
		const _provider = guardString(data.provider, "provider");
		const _appId = guardString(data.appId, "appId");
		if (!ctx.larkChannelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		await ctx.larkChannelManager.removeChannel(_provider, _appId);
		return { success: true };
	},
	"im:reconnect-channel": async (data, ctx) => {
		const _provider = guardString(data.provider, "provider");
		const _appId = guardString(data.appId, "appId");
		if (!ctx.larkChannelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		try {
			await ctx.larkChannelManager.reconnect(_provider, _appId);
			return { success: true };
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	},
	"im:send-test-message": async (data, ctx) => {
		const receiveIdType = guardString(data.receiveIdType, "receiveIdType");
		const receiveId = guardString(data.receiveId, "receiveId");
		const text = guardString(data.text, "text");
		if (!ctx.larkChannelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		return await ctx.larkChannelManager.sendTestMessage({ receiveIdType, receiveId, text });
	},
	"im:test-connection": async (data, ctx) => {
		const appId = guardString(data.appId, "appId");
		if (!ctx.larkChannelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		return await ctx.larkChannelManager.testConnection(appId);
	},
	"im:test-connection-direct": async (data, ctx) => {
		const appId = guardString(data.appId, "appId");
		const appSecret = guardString(data.appSecret, "appSecret");
		guardOptionalString(data.name, "name");
		if (!ctx.larkChannelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		return await ctx.larkChannelManager.testConnectionDirect(appId, appSecret);
	},
	"im:update-channel": async (data, ctx) => {
		const appId = guardString(data.appId, "appId");
		guardOptionalString(data.name, "name");
		if (!ctx.larkChannelManager) {
			return { success: false, error: "Feishu channel manager is not available" };
		}
		await ctx.larkChannelManager.updateChannel(appId, { name: data.name });
		return { success: true };
	},
	"im:get-bindings": async (data, ctx) => {
		if (!ctx.larkBridgeService) {
			return { success: false, error: "LarkBridgeService is not available" };
		}
		return { success: true, bindings: ctx.larkBridgeService.getBindings() };
	},
	"im:remove-binding": async (data, ctx) => {
		const chatId = guardString(data.chatId, "chatId");
		if (!ctx.larkBridgeService) {
			return { success: false, error: "LarkBridgeService is not available" };
		}
		ctx.larkBridgeService.removeBinding(chatId);
		return { success: true };
	},
	"im:get-bridge-status": async (data, ctx) => {
		if (!ctx.larkBridgeService) {
			return { success: false, error: "LarkBridgeService is not available" };
		}
		return { success: true, ...ctx.larkBridgeService.getStatus() };
	},
	// ---- MCP server management ----
	"mcp:list-servers": async (_data, ctx) => {
		await ctx.mcpManager.loadConfig();
		return { success: true, servers: ctx.mcpManager.getStatusList() };
	},
	"mcp:add-server": async (data, ctx) => {
		try {
			await ctx.mcpManager.addServer(data.config as Record<string, unknown>);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	},
	"mcp:remove-server": async (data, ctx) => {
		try {
			await ctx.mcpManager.removeServer(guardString(data.name, "name"));
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	},
	"mcp:test-server": async (data, ctx) => {
		return ctx.mcpManager.testServer(guardString(data.name, "name"));
	},
	"mcp:list-tools": async (data, ctx) => {
		const tools = ctx.mcpManager.getToolsForServer(guardString(data.name, "name"));
		return { success: true, tools };
	},
	"mcp:list-all-tools": async (_data, ctx) => {
		return { success: true, tools: ctx.mcpManager.getAllTools() };
	},
	"mcp:toggle-server": async (data, ctx) => {
		try {
			await ctx.mcpManager.toggleServer(guardString(data.name, "name"), guardBoolean(data.enabled, "enabled"));
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	},
	"mcp:update-server": async (data, ctx) => {
		try {
			await ctx.mcpManager.updateServer(guardString(data.name, "name"), data.config as Record<string, unknown>);
			return { success: true };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	},
};

async function handleRendererInvoke(
	data: RendererToMainEvent,
	runtimeManager: SessionRuntimeManager,
	mainWindow: BrowserWindow,
	workspaceFileService: WorkspaceFileService,
	workspaceTreeService: WorkspaceTreeService,
	larkChannelManager: import("../im/lark-channel-manager.js").LarkChannelManager | undefined,
	larkBridgeService: import("../im/lark-bridge-service.js").LarkBridgeService | undefined,
): Promise<unknown> {
	const ctx: InvokeContext = {
		runtimeManager,
		mainWindow,
		workspaceFileService,
		workspaceTreeService,
		larkChannelManager,
		larkBridgeService,
		mcpManager: runtimeManager.mcpManager,
	};
	const handler = invokeRouteMap[data.type];
	if (handler) {
		try {
			// `data` is narrowed by `data.type` at runtime to match the handler's expected subtype.
			// TypeScript cannot prove this statically across the map lookup, so we assert here.
			// Safety: the route map is keyed by `data.type`, guaranteeing the handler matches the payload.
			// biome-ignore lint/suspicious/noExplicitAny: TypeScript cannot prove the narrowing across map lookup.
			return await handler(data as any, ctx);
		} catch (err) {
			return { success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}
	// biome-ignore lint/suspicious/noExplicitAny: fallback error message needs `.type`.
	return { success: false, error: `Unknown event: ${(data as any).type}` };
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
		detail: `${project.cwd}\n\nThis allows Look to load project settings and resources, install missing packages, and execute project extensions.`,
		buttons: ["Trust", "Do Not Trust"],
		defaultId: 1,
		cancelId: 1,
	});
	await manager.setProjectTrust(projectId, result.response === 0);
}
