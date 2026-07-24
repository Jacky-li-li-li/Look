// ============================================================
// Core Contracts — interfaces that define the architecture
//
// Every domain service depends on these abstractions, not on
// concrete implementations.
//
// ISP: interfaces are minimal; consumers depend only on what they need.
// DIP: services depend on interfaces, not concrete classes.
// Single source: all cross-module contracts live here.
// ============================================================

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
	EventCallback,
	LookUiEvent,
	MainToRendererEvent,
	PermissionMode,
	PermissionRespondPayload,
	PlanApprovalOutcome,
	PlanApprovalResponse,
	PlanQuestion,
	PlanQuestionOutcome,
	PlanQuestionResponse,
	SessionSnapshotEnvelope,
	ToolCallHandler,
} from "@look/shared/types";
import type { ContentBlockTracker } from "../session/event-translator.js";

// ═══════════════════════════════════════════════════════════
// Infrastructure
// ═══════════════════════════════════════════════════════════

export interface IEventBus {
	emit(event: MainToRendererEvent): void;
	onEvent(callback: EventCallback): () => void;
}

export interface IRuntimeStore {
	getRuntime(sessionId: string): AgentSessionRuntime | undefined;
	getSession(sessionId: string): AgentSession | undefined;
	getSessionManager(sessionId: string): SessionManager | undefined;
	getCwd(sessionId: string): string;
	getProjectRoot(): string;
}

// ═══════════════════════════════════════════════════════════
// Runtime lifecycle (ISP-split)
// ═══════════════════════════════════════════════════════════

/**
 * Narrow host for SubAgentRuntimeService.
 *
 * Extracted from IRuntimeLifecycle so consumers are not forced to
 * depend on all 11 methods when they only need runtime disposal,
 * path lookup, and emit. SubAgentRuntimeService depends on this
 * interface — not the full IRuntimeLifecycle.
 *
 * Methods: getRuntime, getSession, getStoredSessionPath,
 * disposeRuntime, emit.
 */
export interface ISubAgentRuntimeHost {
	getRuntime(sessionId: string): AgentSessionRuntime | undefined;
	getSession(sessionId: string): AgentSession | undefined;
	getStoredSessionPath(sessionId: string): string | undefined;
	disposeRuntime(sessionId: string, abort?: boolean): Promise<void>;
	emit(event: MainToRendererEvent): void;
}

/**
 * Full runtime lifecycle. SRT implements this.
 * Kept as a composed interface for backward compatibility — services that
 * need all three capabilities (event bus + store + lifecycle) can depend
 * on this single interface.
 */
export interface IRuntimeLifecycle extends IEventBus, IRuntimeStore {
	disposeRuntime(sessionId: string, abort?: boolean): Promise<void>;
	getStoredSessionPath(sessionId: string): string | undefined;
	getSessionCwd(sessionId: string): string;
	hasCleanupTimer(sessionId: string): boolean;
}

// ═══════════════════════════════════════════════════════════
// Session event host (moved from event-processor.ts)
// ═══════════════════════════════════════════════════════════

export interface ISessionEventHost {
	onAgentEnd(sessionId: string, willRetry: boolean): Promise<void>;
	onMessageEnd(sessionId: string, message: AgentMessage): Promise<void>;
	onSubSessionAgentEnd(sessionId: string): void;
	emitSessionUpdated(sessionId: string): void;
	emitSessionState(sessionId: string, reason: SessionSnapshotEnvelope["reason"], willRetry?: boolean): void;
	emitTodoUpdate(sessionId: string): void;
	emitContextUsage(sessionId: string): void;
}

// ═══════════════════════════════════════════════════════════
// Permission
// ═══════════════════════════════════════════════════════════

export interface IPermissionService {
	getMode(sessionId: string): PermissionMode;
	setDefaultMode(mode: PermissionMode): void;
	getDefaultMode(): PermissionMode;
	setMode(sessionId: string, mode: PermissionMode): void;
	restoreFromSession(sessionId: string, manager: SessionManager): PermissionMode;
	persistIfDirty(sessionId: string, manager: SessionManager): void;
	disposeSession(sessionId: string): void;
	createToolCallHandler(cwd: string): ToolCallHandler;
	handleResponse(payload: PermissionRespondPayload): boolean;
	cancelPending(sessionId: string): void;
}

// ═══════════════════════════════════════════════════════════
// Plan
// ═══════════════════════════════════════════════════════════

export interface IPlanService {
	restoreToolSnapshot(sessionId: string, manager: SessionManager): void;
	syncToolState(sessionId: string): void;
	persistToolSnapshotIfDirty(sessionId: string, manager: SessionManager): void;
	disposeSession(sessionId: string): void;
	capturePrePlanTools(sessionId: string): void;
	restrictToolsForPlan(sessionId: string): void;
	restorePrePlanTools(sessionId: string): void;
	requestQuestions(sessionId: string, questions: PlanQuestion[], signal?: AbortSignal): Promise<PlanQuestionOutcome>;
	handleQuestionResponse(payload: PlanQuestionResponse): boolean;
	requestApproval(sessionId: string, plan: string, signal?: AbortSignal): Promise<PlanApprovalOutcome>;
	handleApprovalResponse(payload: PlanApprovalResponse): Promise<boolean>;
	cancelInteractions(sessionId: string, reason: string): void;
}

// ═══════════════════════════════════════════════════════════
// Session scope
// ═══════════════════════════════════════════════════════════

export interface ISessionScope {
	readonly sessionId: string;
	readonly projectId: string;
	uiEventBuffer: LookUiEvent[];
	uiEventFlushTimer: ReturnType<typeof setTimeout> | null;
	uiEventFirstTimer: ReturnType<typeof setTimeout> | null;
	translationTracker: ContentBlockTracker;
	isDefaultName: boolean;
	turnStartedAt: number | null;
	imProvider?: string;
}

export interface ISessionScopeRegistry {
	acquire(sessionId: string, projectId: string): ISessionScope;
	release(sessionId: string): void;
	get(sessionId: string): ISessionScope | undefined;
	has(sessionId: string): boolean;
}

// ═══════════════════════════════════════════════════════════
// Project trust
// ═══════════════════════════════════════════════════════════

/**
 * Narrow interface for project-trust operations.
 *
 * Extracted from SessionRuntimeManager's large public API so callers like
 * `promptForProjectTrust()` and IPC routers don't depend on the monolithic
 * SRT class. SRT structurally satisfies this interface (it has
 * getProjectTrustStatus, listProjects, and setProjectTrust).
 */
export interface IProjectTrustManager {
	getProjectTrustStatus(projectId: string): {
		requiresTrust: boolean;
		decision: boolean | null;
		shouldAsk: boolean;
	};
	listProjects(): import("@look/shared/types").ProjectInfo[];
	setProjectTrust(projectId: string, trusted: boolean): Promise<void>;
}

/**
 * Narrow interface for IM (Lark) bridge operations on the agent runtime.
 *
 * Extracted from SessionRuntimeManager so the LarkBridgeService depends on
 * a focused contract rather than the ~50-method SRT public API. This makes
 * the dependency direction explicit and the contract testable in isolation.
 */
export interface IImAgentHost {
	getActiveProject(): import("@look/shared/types").ProjectInfo | null;
	listProjects(): import("@look/shared/types").ProjectInfo[];
	createAgent(
		opts?:
			| {
					name?: string;
					projectId?: string;
					imProvider?: import("@look/shared/types").ImSessionProvider;
					background?: boolean;
			  }
			| string,
	): Promise<string>;
	getAgentInfo(sessionId: string): import("@look/shared/types").AgentInfo | undefined;
	abortAgent(sessionId: string): Promise<void>;
	sendMessage(sessionId: string, text: string, images?: import("@earendil-works/pi-ai").ImageContent[]): Promise<void>;
	setModel(sessionId: string, modelKey: string): Promise<void>;
	createProject(
		cwd: string,
		name?: string,
	): Promise<{ project: import("@look/shared/types").ProjectInfo; isDuplicate: boolean }>;
	onEvent(callback: import("@look/shared/types").EventCallback): () => void;
	readonly modelRegistry: import("@earendil-works/pi-coding-agent").ModelRegistry;
}

/**
 * Host contract for headless agent execution (scheduled tasks, manual runs).
 * Extracted from SessionRuntimeManager so headless-agent-runner doesn't
 * depend on the concrete class.
 */
export interface IHeadlessExecutionHost {
	getProjectInfo(projectId: string): import("@look/shared/types").ProjectInfo | null;
	createAgent(
		opts?:
			| {
					name?: string;
					projectId?: string;
					imProvider?: import("@look/shared/types").ImSessionProvider;
					background?: boolean;
			  }
			| string,
	): Promise<string>;
	setModel(sessionId: string, modelKey: string): Promise<void>;
	setInternalPermissionMode(sessionId: string, mode: import("@look/shared/types").PermissionMode): Promise<void>;
	getSession(sessionId: string): import("@earendil-works/pi-coding-agent").AgentSession | undefined;
	abortAgent(sessionId: string): Promise<void>;
	sendMessage(sessionId: string, text: string, images?: import("@earendil-works/pi-ai").ImageContent[]): Promise<void>;
	disposeRuntime(sessionId: string, abort?: boolean): Promise<void>;
}

/**
 * Minimal event and project-query surface needed while composing services.
 * Runtime lifecycle methods are supplied separately to consumers that
 * require them; this contract intentionally does not expose the manager.
 */
export interface ICompositionHost extends IEventBus, ISessionEventHost {
	listProjects(): import("@look/shared/types").ProjectInfo[];
}
