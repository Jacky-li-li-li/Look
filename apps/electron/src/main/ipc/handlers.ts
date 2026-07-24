// ============================================================
// IPC Handlers
// Bridges Electron IPC between renderer and the pi session runtime registry.
// Domain-specific routes live in src/main/ipc/routers/; this file only wires
// them together and forwards runtime events to the renderer window.
// ============================================================

import type { RendererToMainEvent } from "@look/shared/types";
import { type BrowserWindow, ipcMain } from "electron";
import type { SessionRuntimeManager } from "../session/runtime-manager.js";
import type { InvokeContext, InvokeRouteMap } from "./invoke-context.js";
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
];

/** Route map built once in registerIpcHandlers; ctx properties are stable references. */
let invokeRouteMap: InvokeRouteMap = {};

export function registerIpcHandlers(
	runtimeManager: SessionRuntimeManager,
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

	const workspaceFileService = runtimeManager.getWorkspaceFileService();
	// 重建窗口时先清旧 callback,避免 chokidar emit 同时打到新/旧 window(M-7)。
	workspaceFileService.clearEmitCallback();
	workspaceFileService.setEmitCallback((event) => rendererEvents.send(event));

	const workspaceTreeService = runtimeManager.getWorkspaceTreeService();
	workspaceTreeService.clearEmitCallback();
	workspaceTreeService.setEmitCallback((event) => rendererEvents.send(event));

	// Forward session-scoped runtime events to the renderer.
	const unsubscribeEvents = runtimeManager.onEvent((event) => rendererEvents.send(event));

	mainWindow.on("closed", () => {
		unsubscribeEvents();
		// workspaceFileService.dispose() / workspaceTreeService.dispose() 由 SessionRuntimeManager.dispose() 统一处理
	});

	// Build the route map once. All ctx properties are stable references to the
	// same underlying objects (runtimeManager, mainWindow, etc.) so closures
	// capturing ctx remain valid across invocations.

	// Temporary bridge: access composition services until routers migrate to
	// direct service references on ctx.
	const comp = runtimeManager._getComposition();

	const ctx: InvokeContext = {
		runtimeManager,
		mainWindow,
		modelRuntime: runtimeManager.modelRuntime,
		modelRegistry: runtimeManager.modelRegistry,
		credentialStore: runtimeManager.credentialStore,
		customProviders: runtimeManager.customProviders,
		workspaceFileService,
		workspaceTreeService,
		larkChannelManager,
		larkBridgeService,
		mcpManager: runtimeManager.mcpManager,
		schedulerService,

		// Session domain services (migrated from ctx.runtimeManager.*)
		sessionMessaging: comp.sessionMessagingService,
		sessionControl: comp.sessionControlService,
		sessionHistory: comp.sessionHistoryService,
		sessionLifecycle: comp.sessionLifecycleService,
		sessionSettings: comp.sessionSettingsService,
		sessionInfo: comp.sessionInfoService,
		sessionPermission: comp.sessionPermissionOrchestrator,
		sessionNotifier: comp.sessionNotifier,
		runtimeLifecycle: comp.runtimeLifecycle,

		// Agent domain services
		agentDefinitions: comp.agentDefinitionService,
		subagentService: comp.sessionSubagentService,
		subAgentRegistry: comp.subAgentRegistry,

		// Project domain services
		projectService: comp.projectService,
		projectDeletion: comp.projectDeletionService,
		projectRuntime: comp.projectRuntimeService,
		projectApplication: comp.projectApplicationService,
		projectTrust: {
			getProjectTrustStatus: (projectId) => comp.projectService.getProjectTrustStatus(projectId),
			listProjects: () => comp.projectService.listProjects(),
			setProjectTrust: (projectId, trusted) => comp.projectRuntimeService.setProjectTrust(projectId, trusted),
		},

		// Permission / Plan
		permissionService: comp.permissionService,
		planService: comp.planService,

		// Settings
		promptStore: runtimeManager.promptStore,

		// Skills
		skillService: comp.skillManagementService,
	};
	invokeRouteMap = {};
	for (const router of domainRouters) {
		router(ctx, (type, handler) => {
			(invokeRouteMap as Record<string, unknown>)[type] = handler;
		});
	}

	// Handle renderer → main events
	ipcMain.on("look:event", (_event, data: RendererToMainEvent) => {
		handleRendererEvent(data);
	});

	// Handle renderer → main invocations (request-response)
	ipcMain.handle("look:invoke", async (_event, data: RendererToMainEvent) => {
		try {
			return await handleRendererInvoke(data);
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

async function handleRendererInvoke(data: RendererToMainEvent): Promise<unknown> {
	const handler = invokeRouteMap[data.type];
	if (handler) {
		try {
			// `data` is narrowed by `data.type` at runtime to match the handler's expected subtype.
			// TypeScript cannot prove this statically across the map lookup, so we assert here.
			// Safety: the route map is keyed by `data.type`, guaranteeing the handler matches the payload.
			// biome-ignore lint/suspicious/noExplicitAny: TypeScript cannot prove the narrowing across map lookup.
			return await handler(data as any);
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
				errorCode: (err as NodeJS.ErrnoException)?.code ?? null,
				errorStack: err instanceof Error ? (err.stack ?? null) : null,
			};
		}
	}
	// biome-ignore lint/suspicious/noExplicitAny: fallback error message needs `.type`.
	return { success: false, error: `Unknown event: ${(data as any).type}` };
}
