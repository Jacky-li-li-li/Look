// ============================================================
// IPC invoke context and handler types
//
// Shared by handlers.ts and domain routers so routers do not depend
// on the monolithic registration file.
// ============================================================

import type { BrowserWindow } from "electron";
import type { SessionRuntimeManager } from "../session/runtime-manager.js";
import type { WorkspaceFileService } from "../workspace/workspace-file-service.js";
import type { WorkspaceTreeService } from "../workspace/workspace-tree-service.js";
import type { RendererToMainEvent } from "@look/shared/types";

type InvokeHandler<T extends RendererToMainEvent["type"] = RendererToMainEvent["type"]> = (
	data: Extract<RendererToMainEvent, { type: T }>,
) => unknown;

export interface InvokeContext {
	runtimeManager: SessionRuntimeManager;
	mainWindow: BrowserWindow;
	workspaceFileService: WorkspaceFileService;
	workspaceTreeService: WorkspaceTreeService;
	larkChannelManager?: import("../im/lark-channel-manager.js").LarkChannelManager;
	larkBridgeService?: import("../im/lark-bridge-service.js").LarkBridgeService;
	mcpManager: import("../mcp/manager.js").MCPManager;
}

export type InvokeRouteMap = Partial<{
	[K in RendererToMainEvent["type"]]: InvokeHandler<K>;
}>;

export type RegisterHandler = <T extends RendererToMainEvent["type"]>(
	type: T,
	handler: InvokeHandler<T>,
) => void;

export interface IpcRouter {
	(ctx: InvokeContext, register: RegisterHandler): void;
}
