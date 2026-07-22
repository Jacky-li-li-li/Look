// ============================================================
// IPC invoke context and handler types
//
// Shared by handlers.ts and domain routers so routers do not depend
// on the monolithic registration file.
// ============================================================

import type { CredentialStore } from "@earendil-works/pi-ai";
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RendererToMainEvent } from "@look/shared/types";
import type { BrowserWindow } from "electron";
import type { SchedulerService } from "../scheduler/scheduler-service.js";
import type { SessionRuntimeManager } from "../session/runtime-manager.js";
import type { CustomProvidersStore } from "../settings/custom-providers.js";
import type { WorkspaceFileService } from "../workspace/workspace-file-service.js";
import type { WorkspaceTreeService } from "../workspace/workspace-tree-service.js";

type InvokeHandler<T extends RendererToMainEvent["type"] = RendererToMainEvent["type"]> = (
	data: Extract<RendererToMainEvent, { type: T }>,
) => unknown;

export interface InvokeContext {
	runtimeManager: SessionRuntimeManager;
	mainWindow: BrowserWindow;
	modelRuntime: ModelRuntime;
	modelRegistry: ModelRegistry;
	credentialStore: CredentialStore;
	customProviders: CustomProvidersStore;
	workspaceFileService: WorkspaceFileService;
	workspaceTreeService: WorkspaceTreeService;
	larkChannelManager?: import("../im/lark-channel-manager.js").LarkChannelManager;
	larkBridgeService?: import("../im/lark-bridge-service.js").LarkBridgeService;
	mcpManager: import("../mcp/manager.js").MCPManager;
	schedulerService: SchedulerService;
}

export type InvokeRouteMap = Partial<{
	[K in RendererToMainEvent["type"]]: InvokeHandler<K>;
}>;

export type RegisterHandler = <T extends RendererToMainEvent["type"]>(type: T, handler: InvokeHandler<T>) => void;

export type IpcRouter = (ctx: InvokeContext, register: RegisterHandler) => void;
