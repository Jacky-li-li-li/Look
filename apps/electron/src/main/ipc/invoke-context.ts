// ============================================================
// IPC invoke context and handler types
//
// Shared by handlers.ts and domain routers. Domain services are
// exposed directly so routers depend on specific services, not
// the monolithic SessionRuntimeManager.
// ============================================================

import type { CredentialStore } from "@earendil-works/pi-ai";
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RendererToMainEvent } from "@look/shared/types";
import type { BrowserWindow } from "electron";
import type { AgentDefinitionService } from "../agents/definition-service.js";
import type { MCPManager } from "../mcp/manager.js";
import type { PlanService } from "../permissions/plan.js";
import type { PermissionService } from "../permissions/service.js";
import type { ProjectDeletionService } from "../projects/project-deletion-service.js";
import type { ProjectService } from "../projects/project-service.js";
import type { SchedulerService } from "../scheduler/scheduler-service.js";
import type { ProjectRuntimeService } from "../session/project-runtime-service.js";
import type { SessionRuntimeManager } from "../session/runtime-manager.js";
import type { SessionControlService } from "../session/session-control-service.js";
import type { SessionHistoryService } from "../session/session-history-service.js";
import type { SessionInfoService } from "../session/session-info-service.js";
import type { SessionLifecycleService } from "../session/session-lifecycle-service.js";
import type { SessionMessagingService } from "../session/session-messaging-service.js";
import type { SessionNotifier } from "../session/session-notifier.js";
import type { SessionPermissionOrchestrator } from "../session/session-permission-orchestrator.js";
import type { SessionSettingsService } from "../session/session-settings-service.js";
import type { SessionSubagentService } from "../session/session-subagent-service.js";
import type { SkillManagementService } from "../session/skill-management-service.js";
import type { SubAgentRegistry } from "../session/subagent-registry.js";
import type { CustomProvidersStore } from "../settings/custom-providers.js";
import type { PromptStore } from "../settings/prompt-store.js";
import type { WorkspaceFileService } from "../workspace/workspace-file-service.js";
import type { WorkspaceTreeService } from "../workspace/workspace-tree-service.js";

type InvokeHandler<T extends RendererToMainEvent["type"] = RendererToMainEvent["type"]> = (
	data: Extract<RendererToMainEvent, { type: T }>,
) => unknown;

export interface InvokeContext {
	// ── Transport ──
	mainWindow: BrowserWindow;

	// ── Model & credentials (already direct, kept for compatibility) ──
	modelRuntime: ModelRuntime;
	modelRegistry: ModelRegistry;
	credentialStore: CredentialStore;
	customProviders: CustomProvidersStore;

	// ── Workspace ──
	workspaceFileService: WorkspaceFileService;
	workspaceTreeService: WorkspaceTreeService;

	// ── IM ──
	larkChannelManager?: import("../im/lark-channel-manager.js").LarkChannelManager;
	larkBridgeService?: import("../im/lark-bridge-service.js").LarkBridgeService;

	// ── MCP ──
	mcpManager: MCPManager;

	// ── Scheduler ──
	schedulerService: SchedulerService;

	// ── Session domain services ──
	sessionMessaging: SessionMessagingService;
	sessionControl: SessionControlService;
	sessionHistory: SessionHistoryService;
	sessionLifecycle: SessionLifecycleService;
	sessionSettings: SessionSettingsService;
	sessionInfo: SessionInfoService;
	sessionPermission: SessionPermissionOrchestrator;
	sessionNotifier: SessionNotifier;

	// ── Agent domain services ──
	agentDefinitions: AgentDefinitionService;
	subagentService: SessionSubagentService;
	subAgentRegistry: SubAgentRegistry;

	// ── Project domain services ──
	projectService: ProjectService;
	projectDeletion: ProjectDeletionService;
	projectRuntime: ProjectRuntimeService;

	// ── Permission / Plan ──
	permissionService: PermissionService;
	planService: PlanService;

	// ── Settings ──
	promptStore: PromptStore;

	// ── Skills ──
	skillService: SkillManagementService;

	// ── Legacy (removed after all routers are migrated) ──
	runtimeManager: SessionRuntimeManager;
}

export type InvokeRouteMap = Partial<{
	[K in RendererToMainEvent["type"]]: InvokeHandler<K>;
}>;

export type RegisterHandler = <T extends RendererToMainEvent["type"]>(type: T, handler: InvokeHandler<T>) => void;

export type IpcRouter = (ctx: InvokeContext, register: RegisterHandler) => void;
