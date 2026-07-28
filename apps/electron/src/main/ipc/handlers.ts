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

import type { RendererToMainEvent } from "@look/shared/types";
import { type BrowserWindow, ipcMain } from "electron";
import type { RuntimeManagerComposition } from "../session/runtime-manager-composition.js";
import { TRAFFIC_LIGHT_X, trafficLightYForCenter } from "../system/traffic-light.js";
import { type InvokeContext, InvokeDispatcher } from "./invoke-context.js";
import type { RendererEventTransport } from "./renderer-event-transport.js";
import {
	agentRouter,
	fileRouter,
	fileViewerRouter,
	historyRouter,
	imRouter,
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
];

export function registerIpcHandlers(
	composition: RuntimeManagerComposition,
	mainWindow: BrowserWindow,
	rendererEvents: RendererEventTransport,
	larkChannelManager?: import("../im/lark-channel-manager.js").LarkChannelManager,
	larkBridgeService?: import("../im/lark-bridge-service.js").LarkBridgeService,
	schedulerService?: import("../scheduler/scheduler-service.js").SchedulerService,
): void {
	if (!schedulerService) throw new Error("Scheduler service is not initialized");
	// Clean up previous registrations to support macOS activate re-creation
	ipcMain.removeHandler("look:invoke");
	ipcMain.removeAllListeners("look:event");

	const workspaceFileService = composition.workspaceFileService;
	// 重建窗口时先清旧 callback,避免 chokidar emit 同时打到新/旧 window(M-7)。
	workspaceFileService?.clearEmitCallback();
	workspaceFileService?.setEmitCallback((event) => rendererEvents.send(event));

	const workspaceTreeService = composition.workspaceTreeService;
	workspaceTreeService?.clearEmitCallback();
	workspaceTreeService?.setEmitCallback((event) => rendererEvents.send(event));

	// Forward session-scoped runtime events to the renderer.
	const unsubscribeEvents = composition.eventBus.onEvent((event) => rendererEvents.send(event));

	mainWindow.on("closed", () => {
		unsubscribeEvents();
	});

	const ctx = {
		mainWindow,

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
	} as InvokeContext;

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
			return await dispatcher.dispatch(data);
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
