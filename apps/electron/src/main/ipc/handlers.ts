// ============================================================
// IPC Handlers
// Bridges Electron IPC between renderer and the pi session runtime registry.
// Domain-specific routes live in src/main/ipc/routers/; this file only wires
// them together and forwards runtime events to the renderer window.
//
// NOTE: This module receives a RuntimeManagerComposition directly, NOT a
// SessionRuntimeManager. This eliminates the _getComposition() bridge and
// keeps IPC routing decoupled from the bootstrap facade.
// ============================================================

import type { LookIslandSettings, RendererToMainEvent } from "@look/shared/types";
import { type BrowserWindow, ipcMain } from "electron";
import { GitService } from "../git/git-service.js";
import type { RuntimeManagerComposition } from "../session/runtime-manager-composition.js";
import { TRAFFIC_LIGHT_X, trafficLightYForCenter } from "../system/traffic-light.js";
import { ensureIpcEnvelopeShape } from "../utils/ipc-envelope.js";
import { type InvokeContext, InvokeDispatcher } from "./invoke-context.js";
import type { RendererEventTransport } from "./renderer-event-transport.js";
import {
	agentRouter,
	fileRouter,
	fileViewerRouter,
	historyRouter,
	imRouter,
	lookIslandRouter,
	mcpRouter,
	modelRouter,
	permissionRouter,
	projectRouter,
	schedulerRouter,
	settingsRouter,
	sharedRouter,
	skillRouter,
	subagentRouter,
	systemRouter,
	updaterRouter,
	workspaceRouter,
} from "./routers/index.js";

/** 模块级 GitService：窗口重建（registerIpcHandlers 重跑）时先 dispose 旧实例的 watcher。 */
let gitService: GitService | null = null;

const domainRouters = [
	agentRouter,
	fileRouter,
	fileViewerRouter,
	historyRouter,
	modelRouter,
	settingsRouter,
	projectRouter,
	schedulerRouter,
	permissionRouter,
	subagentRouter,
	skillRouter,
	sharedRouter,
	workspaceRouter,
	systemRouter,
	imRouter,
	mcpRouter,
	updaterRouter,
	lookIslandRouter,
];

export function registerIpcHandlers(
	composition: RuntimeManagerComposition,
	mainWindow: BrowserWindow,
	rendererEvents: RendererEventTransport,
	larkChannelManager?: import("../im/lark-channel-manager.js").LarkChannelManager,
	larkBridgeService?: import("../im/lark-bridge-service.js").LarkBridgeService,
	schedulerService?: import("../scheduler/scheduler-service.js").SchedulerService,
	lookIslandController?: {
		getSettings(): LookIslandSettings;
		setEnabled(enabled: boolean): LookIslandSettings;
	} | null,
): void {
	if (!schedulerService) throw new Error("Scheduler service is not initialized");
	// Clean up previous registrations to support macOS activate re-creation
	ipcMain.removeHandler("look:invoke");
	ipcMain.removeAllListeners("look:event");

	const workspaceFileService = composition.workspaceFileService;
	if (!workspaceFileService) throw new Error("Workspace file service is not initialized");
	// 重建窗口时先清旧 callback,避免 chokidar emit 同时打到新/旧 window(M-7)。
	workspaceFileService.clearEmitCallback();
	workspaceFileService.setEmitCallback((event) => rendererEvents.send(event));

	const workspaceTreeService = composition.workspaceTreeService;
	if (!workspaceTreeService) throw new Error("Workspace tree service is not initialized");
	workspaceTreeService.clearEmitCallback();
	workspaceTreeService.setEmitCallback((event) => rendererEvents.send(event));

	// Read-only git repo detection (recreated on window re-create; cache TTL is short).
	// Module-level so the previous instance's HEAD watchers are disposed on re-create.
	gitService?.dispose();
	gitService = new GitService();

	// Forward session-scoped runtime events to the renderer.
	const unsubscribeEvents = composition.eventBus.onEvent((event) => rendererEvents.send(event));

	mainWindow.on("closed", () => {
		unsubscribeEvents();
	});

	const ctx = {
		mainWindow,

		lookIsland: lookIslandController ?? null,

		model: {
			runtime: composition.modelRuntime,
			registry: composition.modelRegistry,
			credentials: composition.credentialStore,
			customProviders: composition.customProviders,
		},

		session: {
			messaging: composition.sessionMessagingService,
			control: composition.sessionControlService,
			history: composition.sessionHistoryService,
			lifecycle: composition.sessionLifecycleService,
			settings: composition.sessionSettingsService,
			info: composition.sessionInfoService,
			permission: composition.sessionPermissionOrchestrator,
			notifier: composition.sessionNotifier,
		},

		runtime: {
			lifecycle: composition.runtimeLifecycle,
			registry: composition.runtimeRegistry,
		},

		agent: {
			definitions: composition.agentDefinitionService,
			subagentService: composition.sessionSubagentService,
			subAgentRegistry: composition.subAgentRegistry,
		},

		project: {
			service: composition.projectService,
			deletion: composition.projectDeletionService,
			runtime: composition.projectRuntimeService,
			application: composition.projectApplicationService,
			trust: {
				getProjectTrustStatus: (projectId: string) => composition.projectService.getProjectTrustStatus(projectId),
				listProjects: () => composition.projectService.listProjects(),
				setProjectTrust: (projectId: string, trusted: boolean) =>
					composition.projectRuntimeService.setProjectTrust(projectId, trusted),
			},
		},

		git: {
			service: gitService,
		},

		permission: {
			service: composition.permissionService,
			plan: composition.planService,
		},

		workspace: {
			fileService: workspaceFileService,
			treeService: workspaceTreeService,
		},

		im: {
			channelManager: larkChannelManager,
			bridgeService: larkBridgeService,
		},

		mcp: composition.mcpManager,
		scheduler: schedulerService,
		skill: composition.skillManagementService,
		settings: { prompts: composition.promptStore },
	} satisfies InvokeContext;

	// Build the dispatcher from all domain routers
	const dispatcher = new InvokeDispatcher();
	for (const router of domainRouters) {
		dispatcher.install(router, ctx);
	}

	// Handle renderer → main events (fire-and-forget)
	ipcMain.on("look:event", (_event, data: RendererToMainEvent) => {
		switch (data.type) {
			case "app:ready":
				break;
			// 渲染端实测顶部栏可视中心(CSS px) → 校正 macOS 红绿灯垂直位置。
			// CSS px 乘 zoomFactor 换算为 pt;仅 macOS 有 hiddenInset 红绿灯。
			case "window:traffic-light-center": {
				if (process.platform !== "darwin" || mainWindow.isDestroyed()) break;
				const zoom = mainWindow.webContents.zoomFactor || 1;
				mainWindow.setWindowButtonPosition({
					x: TRAFFIC_LIGHT_X,
					y: trafficLightYForCenter(data.centerCssPx * zoom),
				});
				break;
			}
		}
	});

	// Handle renderer → main invocations (request-response)
	ipcMain.handle("look:invoke", async (_event, data: RendererToMainEvent) => {
		try {
			// 信封守卫：handler 返回类型是 unknown，typecheck 覆盖不到返回值形状，
			// 这里运行时校验失败分支必须带 error（违反时抛错走统一 catch）。
			return ensureIpcEnvelopeShape(await dispatcher.dispatch(data));
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
