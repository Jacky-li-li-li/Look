// ============================================================
// Core Contracts — interfaces that define the architecture
//
// Every domain service depends on these abstractions, not on
// concrete implementations. SessionRuntimeManager implements
// both IEventBus and IRuntimeStore so services receive `this`
// without needing to know about SRT internals.
//
// To add a new service:
//   1. Define its interface here
//   2. Implement it in src/main/services/<name>/
//   3. Inject it into SRT's constructor
// ============================================================

import type { AgentSession, AgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
	PlanApprovalOutcome,
	PlanQuestionOutcome,
} from "../extensions/plan-extension.js";
import type { ToolCallHandler } from "../extensions/permission-extension.js";
import type {
	EventCallback,
	LookUiEvent,
	MainToRendererEvent,
	PermissionMode,
	PermissionRespondPayload,
	PlanApprovalResponse,
	PlanQuestion,
	PlanQuestionResponse,
} from "../shared/types.js";
import type { ContentBlockTracker } from "../session/event-translator.js";

// ── Infrastructure ──

/** Minimal event bus for IPC → renderer. SRT implements this. */
export interface IEventBus {
	emit(event: MainToRendererEvent): void;
	onEvent(callback: EventCallback): () => void;
}

/** Runtime / session lookup. Owned by SessionRuntimeManager. */
export interface IRuntimeStore {
	/** Get the pi AgentSessionRuntime for a session, or undefined if not live. */
	getRuntime(sessionId: string): AgentSessionRuntime | undefined;

	/** Get the pi AgentSession for a session, or undefined if not live. */
	getSession(sessionId: string): AgentSession | undefined;

	/** Get the SessionManager (persistence layer) for a session. */
	getSessionManager(sessionId: string): SessionManager | undefined;

	/** Get the working directory for a session. */
	getCwd(sessionId: string): string;

	/** Resolve the cwd of the currently active project. */
	getProjectRoot(): string;
}

// ── Permission ──

/** Per-session tool call authorization. */
export interface IPermissionService {
	getMode(sessionId: string): PermissionMode;
	setDefaultMode(mode: PermissionMode): void;
	getDefaultMode(): PermissionMode;
	setMode(sessionId: string, mode: PermissionMode): void;

	/** Restore the permission mode from persisted JSONL entries. */
	restoreFromSession(sessionId: string, manager: SessionManager): PermissionMode;

	/** Persist the mode for a session if marked dirty. */
	persistIfDirty(sessionId: string): void;

	/** Clean up per-session state (called on runtime disposal). */
	disposeSession(sessionId: string): void;

	/** Build the pi SDK tool_call handler for permission gating. */
	createToolCallHandler(cwd: string): ToolCallHandler;

	/** Handle a permission response from the renderer. */
	handleResponse(payload: PermissionRespondPayload): boolean;

	/** Cancel all pending permission requests for a session. */
	cancelPending(sessionId: string): void;
}

// ── Plan ──

/** Plan mode workflow management. */
export interface IPlanService {
	restoreToolSnapshot(sessionId: string, manager: SessionManager): void;
	syncToolState(sessionId: string): void;
	persistToolSnapshotIfDirty(sessionId: string): void;
	disposeSession(sessionId: string): void;

	capturePrePlanTools(sessionId: string): void;
	restrictToolsForPlan(sessionId: string): void;
	restorePrePlanTools(sessionId: string): void;

	requestQuestions(
		sessionId: string,
		questions: PlanQuestion[],
		signal?: AbortSignal,
	): Promise<PlanQuestionOutcome>;

	handleQuestionResponse(payload: PlanQuestionResponse): boolean;

	requestApproval(
		sessionId: string,
		plan: string,
		signal?: AbortSignal,
	): Promise<PlanApprovalOutcome>;

	handleApprovalResponse(
		payload: PlanApprovalResponse,
	): Promise<boolean>;

	cancelInteractions(sessionId: string, reason: string): void;
}

// ── Session Scope (per-session mutable state aggregator) ──

/**
 * Aggregates per-session mutable state that multiple domain services
 * need to read/write. Owned by ISessionScopeRegistry and disposed
 * together with the runtime.
 */
export interface ISessionScope {
	readonly sessionId: string;
	readonly projectId: string;

	/** Canonical streaming state derived from SDK events. */
	streamingState: "idle" | "streaming" | "retrying";

	/** Buffered UI events awaiting batch flush. */
	uiEventBuffer: LookUiEvent[];

	/** Timers for the two-stage UI event batching (1ms probe + 8ms batch). */
	uiEventFlushTimer: ReturnType<typeof setTimeout> | null;
	uiEventFirstTimer: ReturnType<typeof setTimeout> | null;

	/** Per-session content block tracker for discrete event translation. */
	translationTracker: ContentBlockTracker;

	/** Whether the session name is still the auto-generated default. */
	isDefaultName: boolean;

	/** Turn start timestamp for computing per-message runtimes. */
	turnStartedAt: number | null;

	/** IM provider for this session (e.g. "feishu"). */
	imProvider?: string;
}

/** Registry that creates / retrieves / releases SessionScope instances. */
export interface ISessionScopeRegistry {
	acquire(sessionId: string, projectId: string): ISessionScope;
	release(sessionId: string): void;
	get(sessionId: string): ISessionScope | undefined;
	has(sessionId: string): boolean;
}
