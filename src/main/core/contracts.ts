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
	MainToRendererEvent,
	PermissionMode,
	PermissionRespondPayload,
	PlanApprovalResponse,
	PlanQuestion,
	PlanQuestionResponse,
} from "../shared/types.js";

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
