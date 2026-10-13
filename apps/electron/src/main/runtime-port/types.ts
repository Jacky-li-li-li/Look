// ============================================================
// RuntimePort — engine-swappable session execution contract
//
// Host (IPC / Session*Service) should eventually depend only on this surface.
// Phase 1 lands the Port + PiAdapter skeleton; default engine remains pi.
// See docs/runtime-adapter.md.
// ============================================================

import type { MainToRendererEvent } from "@look/shared/types";

/** Supported execution engines. Only `"pi"` is implemented in Phase 1. */
export type EngineId = "pi" | "dsh" | "claude-code";

/**
 * Capability flags each adapter must declare explicitly.
 * Unsupported features must be `false` (UI greys out) — never silently degrade.
 */
export interface EngineCapabilities {
	fork: boolean;
	compaction: boolean;
	/** pi `/skill:name` slash invocation */
	skillsSlash: boolean;
	mcp: boolean;
	computerUse: boolean;
	/** pi navigateTree / session tree */
	sessionTree: boolean;
}

/** Opaque engine-side session handle. Callers must not interpret fields beyond identity. */
export interface EngineSessionRef {
	readonly engineId: EngineId;
	/** Look / engine session id (for pi this is the pi session id). */
	readonly sessionId: string;
}

/**
 * Input for creating a new engine session.
 * `engine` stays opaque on the Port surface so Session*Service can stop importing pi later.
 * PiAdapter narrows it to {@link import("./pi-adapter.js").PiEngineCreateOptions}.
 */
export interface CreateSessionInput {
	cwd: string;
	/** Engine-private construction payload (e.g. pi SessionManager + start event). */
	engine?: unknown;
}

/** User turn payload delivered through the Port. */
export interface UserMessage {
	text: string;
	/** Optional image parts; shape matches pi ImageContent when using PiAdapter. */
	images?: unknown[];
	/** How to queue when the engine is already streaming (pi: steer | followUp). */
	streamingBehavior?: "steer" | "followUp";
	/** Engine prompt preflight callback (pi preflightResult). */
	onPreflight?: (success: boolean) => void;
}

/**
 * Look session UI events — same shape as existing main→renderer IPC.
 * Adapters must map engine events into this union; no parallel IPC channels.
 */
export type LookSessionEvent = MainToRendererEvent;

/** Tool-approval decision Look resolved and feeds back into the engine. */
export interface ApprovalDecision {
	requestId: string;
	action: "allow" | "deny" | "allow_always";
}

export type Unsubscribe = () => void;

/**
 * Minimal frozen surface every execution engine must implement.
 * Second-phase concerns (fork/tree, skill hot-reload, MCP bridge, CU) stay out.
 */
export interface RuntimePort {
	readonly engineId: EngineId;
	readonly capabilities: EngineCapabilities;

	create(input: CreateSessionInput): Promise<EngineSessionRef>;
	resume(ref: EngineSessionRef): Promise<void>;
	dispose(ref: EngineSessionRef): Promise<void>;

	send(ref: EngineSessionRef, message: UserMessage): Promise<void>;
	abort(ref: EngineSessionRef): Promise<void>;

	/** Subscribe to engine events mapped as Look SessionEvent. */
	subscribe(ref: EngineSessionRef, sink: (event: LookSessionEvent) => void): Unsubscribe;

	/** Look decided allow/deny; adapter forwards into the engine / permission gate. */
	resolveToolApproval(ref: EngineSessionRef, decision: ApprovalDecision): Promise<void>;
}

/** pi engine capabilities — full Look feature set on the default path. */
export const PI_ENGINE_CAPABILITIES: EngineCapabilities = {
	fork: true,
	compaction: true,
	skillsSlash: true,
	mcp: true,
	computerUse: true,
	sessionTree: true,
};
