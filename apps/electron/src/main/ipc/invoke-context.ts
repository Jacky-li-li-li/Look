// ============================================================
// IPC invoke context and handler types
//
// Shared by handlers.ts and domain routers. Domain services are
// grouped by domain so routers depend on minimal service surfaces.
// ============================================================

import type { CredentialStore } from "@earendil-works/pi-ai";
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RendererToMainEvent } from "@look/shared/types";
import type { BrowserWindow } from "electron";
import type { AgentDefinitionService } from "../agents/definition-service.js";
import type { IProjectTrustManager } from "../core/contracts.js";
import type { GitService } from "../git/git-service.js";
import type { MCPManager } from "../mcp/manager.js";
import type { PlanService } from "../permissions/plan.js";
import type { PermissionService } from "../permissions/service.js";
import type { ProjectDeletionService } from "../projects/project-deletion-service.js";
import type { ProjectService } from "../projects/project-service.js";
import type { SchedulerService } from "../scheduler/scheduler-service.js";
import type { SessionNotifier } from "../session/events/session-notifier.js";
import type { RuntimeLifecycleCoordinator } from "../session/runtime/runtime-lifecycle-coordinator.js";
import type { RuntimeRegistry } from "../session/runtime/runtime-registry.js";
import type { ProjectApplicationService } from "../session/services/project-application-service.js";
import type { ProjectRuntimeService } from "../session/services/project-runtime-service.js";
import type { SessionControlService } from "../session/services/session-control-service.js";
import type { SessionHistoryService } from "../session/services/session-history-service.js";
import type { SessionInfoService } from "../session/services/session-info-service.js";
import type { SessionLifecycleService } from "../session/services/session-lifecycle-service.js";
import type { SessionMessagingService } from "../session/services/session-messaging-service.js";
import type { SessionPermissionOrchestrator } from "../session/services/session-permission-orchestrator.js";
import type { SessionSettingsService } from "../session/services/session-settings-service.js";
import type { SessionSubagentService } from "../session/services/session-subagent-service.js";
import type { SkillManagementService } from "../session/services/skill-management-service.js";
import type { SubAgentRegistry } from "../session/subagent-registry.js";
import type { CustomProvidersStore } from "../settings/custom-providers.js";
import type { PromptStore } from "../settings/prompt-store.js";
import type { WorkspaceFileService } from "../workspace/workspace-file-service.js";
import type { WorkspaceTreeService } from "../workspace/workspace-tree-service.js";

// ============================================================
// Domain-grouped InvokeContext
// ============================================================

export interface InvokeContext {
	// ── Transport (kept flat — used across most routers) ──
	mainWindow: BrowserWindow;

	// ── Model ──
	model: {
		runtime: ModelRuntime;
		registry: ModelRegistry;
		credentials: CredentialStore;
		customProviders: CustomProvidersStore;
	};

	// ── Session ──
	session: {
		messaging: SessionMessagingService;
		control: SessionControlService;
		history: SessionHistoryService;
		lifecycle: SessionLifecycleService;
		settings: SessionSettingsService;
		info: SessionInfoService;
		permission: SessionPermissionOrchestrator;
		notifier: SessionNotifier;
	};

	// ── Runtime lifecycle ──
	runtime: {
		lifecycle: RuntimeLifecycleCoordinator;
		/** Serialized operation lock per session (for queue ops, etc.). */
		registry: RuntimeRegistry;
	};

	// ── Agent definitions / SubAgent ──
	agent: {
		definitions: AgentDefinitionService;
		subagentService: SessionSubagentService;
		subAgentRegistry: SubAgentRegistry;
	};

	// ── Project ──
	project: {
		service: ProjectService;
		deletion: ProjectDeletionService;
		runtime: ProjectRuntimeService;
		application: ProjectApplicationService;
		trust: IProjectTrustManager;
	};

	// ── Permission / Plan ──
	permission: {
		service: PermissionService;
		plan: PlanService;
	};

	// ── Git (read-only repo detection) ──
	git: {
		service: GitService;
	};

	// ── Workspace ──
	workspace: {
		fileService: WorkspaceFileService;
		treeService: WorkspaceTreeService;
	};

	// ── IM / Feishu ──
	im: {
		channelManager?: import("../im/lark-channel-manager.js").LarkChannelManager;
		bridgeService?: import("../im/lark-bridge-service.js").LarkBridgeService;
	};

	// ── Standalone services (only one per domain) ──
	mcp: MCPManager;
	scheduler: SchedulerService;
	skill: SkillManagementService;
	settings: { prompts: PromptStore };
}

// ============================================================
// InvokeHandler + InvokeRouteMap
// ============================================================

type InvokeHandler<T extends RendererToMainEvent["type"] = RendererToMainEvent["type"]> = (
	data: Extract<RendererToMainEvent, { type: T }>,
) => unknown;

export type RegisterHandler = <T extends RendererToMainEvent["type"]>(type: T, handler: InvokeHandler<T>) => void;

export type IpcRouter = (ctx: InvokeContext, register: RegisterHandler) => void;

// ============================================================
// InvokeDispatcher — type-safe dispatch without `as any`
//
// The register() method preserves the type relationship between
// event type and handler. dispatch() contains one internal cast,
// but callers never need to cast — the invariant is maintained
// by construction.
// ============================================================

export class InvokeDispatcher {
	private handlers = new Map<string, InvokeHandler>();

	/**
	 * Every event type that has been registered. The contract-exhaustiveness
	 * test (test/ipc-exhaustiveness.test.ts) installs all routers and asserts
	 * this set covers the full RendererToMainEvent union, so a newly added
	 * event without a handler fails CI instead of failing silently at runtime.
	 */
	readonly registeredTypes = new Set<string>();

	register<T extends RendererToMainEvent["type"]>(type: T, handler: InvokeHandler<T>): void {
		this.handlers.set(type, handler as unknown as InvokeHandler);
		this.registeredTypes.add(type);
	}

	dispatch(data: RendererToMainEvent): unknown {
		const handler = this.handlers.get(data.type);
		if (!handler) return { success: false, error: `Unknown event: ${data.type}` };
		// SAFETY: register() guarantees each handler matches its key's payload type.
		// The map lookup loses the K <-> Extract<RendererToMainEvent, {type: K}>
		// relationship, but the registration-time invariant ensures correctness.
		return (handler as (data: RendererToMainEvent) => unknown)(data);
	}

	/** Bulk-register all routes from a router. */
	install(router: IpcRouter, ctx: InvokeContext): void {
		router(ctx, (type, handler) => this.register(type, handler));
	}
}
