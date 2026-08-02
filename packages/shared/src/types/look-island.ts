// ============================================================
// Look Island — shared types (main ↔ Swift helper wire contract)
//
// The macOS native island helper is a separate Swift process spawned by
// the Electron main process. It renders an always-on-top notch panel with
// SwiftUI and speaks a newline-delimited JSON protocol over stdio.
//
// Product state stays in TypeScript: a pure reducer subscribes to
// SessionEventBus and produces display-ready snapshots; the helper only
// renders. These types are the single source of truth for that contract.
// ============================================================

export type LookIslandPhase = "idle" | "running" | "needs-interaction" | "completed" | "error";
export type LookIslandNotchStatus = "closed" | "peek" | "expanded";
export type LookIslandDisplayMode = "compact" | "expanded";
export type LookIslandDisplayPolicy = "closed" | "peek" | "blocking" | "transient" | "manualExpanded";
export type LookIslandInteractionKind = "permission" | "ask_user_question" | "plan_review";

/** Compact terminal-style preview line shown inside the expanded island card. */
export interface LookIslandActivityLine {
	id: string;
	kind: "user" | "assistant" | "status" | "tool";
	text: string;
}

export type LookIslandSubagentStatus = "running" | "completed" | "failed" | "aborted";

/** Sub-agent progress snapshot shown in the expanded island card. */
export interface LookIslandSubagentSnapshot {
	toolCallId: string;
	agentName: string;
	taskTitle: string;
	status: LookIslandSubagentStatus;
	model?: string | null;
}

/** Per-session snapshot rendered by the native helper. */
export interface LookIslandSessionSnapshot {
	sessionId: string;
	title: string | null;
	projectName: string | null;
	detail: string;
	phase: LookIslandPhase;
	modelLabel: string | null;
	interactionKind?: LookIslandInteractionKind;
	permissionToolName: string | null;
	attention: boolean;
	activityLines: LookIslandActivityLine[];
	/** Commander-mode sub-agent queue (parent session). */
	subagents?: LookIslandSubagentSnapshot[];
	/** Context window usage percent (0-100), when known. */
	usagePercent?: number | null;
	startedAt: number;
	lastActivityAt: number;
}

/** Vibe-style priority summary for the closed/peek pill. */
export interface LookIslandPillSnapshot {
	phase: LookIslandPhase;
	priorityTitle: string;
	sessionCount: number;
	activeSessionCount: number;
	pendingInteractionCount: number;
	unreadCompletedCount: number;
	/** Any active session is close to its context window limit. */
	usageWarning: boolean;
}

/** User-visible strings rendered by the native helper (main owns i18n). */
export interface LookIslandStrings {
	appName: string;
	running: string;
	completed: string;
	error: string;
	needsInput: string;
	settings: string;
	permissionPromptTitle: string;
	allowOnce: string;
	alwaysAllow: string;
	deny: string;
	planReviewTitle: string;
	approve: string;
	reject: string;
}

export const DEFAULT_LOOK_ISLAND_STRINGS: LookIslandStrings = {
	appName: "Look",
	running: "Running",
	completed: "Completed",
	error: "Error",
	needsInput: "Needs input",
	settings: "Look Island settings",
	permissionPromptTitle: "Confirm permission",
	allowOnce: "Allow once",
	alwaysAllow: "Always allow",
	deny: "Deny",
	planReviewTitle: "Review plan",
	approve: "Approve",
	reject: "Reject",
};

/** Blocking interaction rendered by the native helper (approval card). */
export type LookIslandInteraction =
	| {
			kind: "permission";
			requestId: string;
			sessionId: string;
			toolName: string;
			toolDescription: string;
			canAllowForSession: boolean;
	  }
	| { kind: "plan"; requestId: string; sessionId: string; title: string };

/** Full display payload pushed from main to the native helper. */
export interface LookIslandDisplayState {
	visible: boolean;
	mode: LookIslandDisplayMode;
	notchStatus: LookIslandNotchStatus;
	displayPolicy: LookIslandDisplayPolicy;
	currentSessionId: string | null;
	pillSnapshot: LookIslandPillSnapshot;
	sessions: LookIslandSessionSnapshot[];
	interaction: LookIslandInteraction | null;
	strings: LookIslandStrings;
	updatedAt: number;
}

// ── Native window geometry ──────────────────────────────────────────

export interface LookIslandRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface LookIslandNativeFrame {
	displayId: number;
	displayBounds: LookIslandRect;
	/** Desired content width in points; the helper clamps to its own metrics. */
	contentWidth: number | null;
	/** Horizontal center ratio (0..1) of the island on its display. */
	centerXRatio?: number | null;
}

export interface LookIslandNativeScreenMetrics {
	displayId: number;
	frame: LookIslandRect;
	hasNotch: boolean;
	notchWidth: number;
	topBarHeight: number;
	menuBarHeight: number;
	safeAreaTop: number;
	isMain: boolean;
	signature: string;
}

// ── Dimensions (mirrored in Swift `LookIslandMetrics`) ───────────────

export const LOOK_ISLAND_CLOSED_HEIGHT = 34;
export const LOOK_ISLAND_COMPACT_IDLE_WIDTH = 260;
export const LOOK_ISLAND_COMPACT_ACTIVE_WIDTH = 340;
export const LOOK_ISLAND_COMPACT_MIN_WIDTH = 80;
export const LOOK_ISLAND_CARRIER_COMPACT_INSET = 20;
export const LOOK_ISLAND_MAX_EXPANDED_WIDTH = 640;
export const LOOK_ISLAND_MIN_EXPANDED_WIDTH = 360;
export const LOOK_ISLAND_MAX_EXPANDED_HEIGHT = 560;
export const LOOK_ISLAND_SCREEN_EDGE_GUTTER = 112;
export const LOOK_ISLAND_COMPACT_HARDWARE_EXTRA_WIDTH = 128;
export const LOOK_ISLAND_SIMULATED_NOTCH_WIDTH_RATIO = 0.14;
export const LOOK_ISLAND_SIMULATED_NOTCH_MIN_WIDTH = 160;
export const LOOK_ISLAND_SIMULATED_NOTCH_MAX_WIDTH = 240;

export function computeLookIslandSimulatedNotchWidth(displayWidth: number): number {
	return Math.min(
		LOOK_ISLAND_SIMULATED_NOTCH_MAX_WIDTH,
		Math.max(LOOK_ISLAND_SIMULATED_NOTCH_MIN_WIDTH, displayWidth * LOOK_ISLAND_SIMULATED_NOTCH_WIDTH_RATIO),
	);
}

// ── Downlink protocol (main → helper) ────────────────────────────────

export const LOOK_ISLAND_PROTOCOL_VERSION = 1;

export type LookIslandDownlinkMessage =
	| { type: "update"; protocol: number; state: LookIslandDisplayState; frame: LookIslandNativeFrame }
	| { type: "shutdown" };

// ── Uplink protocol (helper → main) ──────────────────────────────────

export type LookIslandUplinkMessage =
	| { type: "ready"; protocol: number }
	| { type: "expand"; displayId?: number | null }
	| { type: "focus-session"; sessionId: string }
	| { type: "outside-click" }
	| {
			type: "layout";
			displayId?: number | null;
			centerXRatio?: number | null;
			contentWidth?: number | null;
			expanded?: boolean;
	  }
	| {
			type: "permission-action";
			requestId: string;
			action: "allow" | "allowForSession" | "deny";
	  }
	| { type: "plan-action"; requestId: string; sessionId: string; action: "approve" | "reject" }
	| {
			type: "screen-metrics";
			screens: LookIslandNativeScreenMetrics[];
			preferredDisplayId: number | null;
			forceRefresh: boolean;
	  }
	| { type: "debug"; event?: string; message?: string }
	| { type: "error"; message: string };

export const LOOK_ISLAND_MIN_DARWIN_MAJOR = 23; // macOS 14 Sonoma.

/** User-facing Look Island settings (renderer owns, main persists). */
export interface LookIslandSettings {
	enabled: boolean;
}

export const DEFAULT_LOOK_ISLAND_SETTINGS: LookIslandSettings = {
	enabled: false,
};

export function normalizeLookIslandSettings(raw: unknown): LookIslandSettings {
	if (typeof raw !== "object" || raw === null) return { ...DEFAULT_LOOK_ISLAND_SETTINGS };
	const record = raw as Record<string, unknown>;
	return {
		enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_LOOK_ISLAND_SETTINGS.enabled,
	};
}

export function isLookIslandSupportedPlatform(
	platform: string | undefined,
	osRelease: string | null | undefined,
): boolean {
	if (platform !== "darwin") return false;
	const darwinMajor = parseLookIslandDarwinMajor(osRelease);
	return darwinMajor !== null && darwinMajor >= LOOK_ISLAND_MIN_DARWIN_MAJOR;
}

function parseLookIslandDarwinMajor(osRelease: string | null | undefined): number | null {
	if (!osRelease) return null;
	const major = Number.parseInt(osRelease.split(".")[0] ?? "", 10);
	return Number.isFinite(major) ? major : null;
}
