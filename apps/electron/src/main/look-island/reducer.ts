// ============================================================
// LookIslandReducer — pure display-state reducer
//
// Subscribes to MainToRendererEvent (SessionEventBus fan-out) and
// maintains per-session island state. Produces a display-ready
// snapshot for the native helper. No side effects here — the
// service owns publishing.
// ============================================================

import type {
	LookIslandActivityLine,
	LookIslandDisplayPolicy,
	LookIslandDisplayState,
	LookIslandInteraction,
	LookIslandInteractionKind,
	LookIslandPhase,
	LookIslandPillSnapshot,
	LookIslandSessionSnapshot,
	LookIslandSubagentSnapshot,
	MainToRendererEvent,
} from "@look/shared/types";
import { DEFAULT_LOOK_ISLAND_STRINGS } from "@look/shared/types";

interface LookIslandSessionState {
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
	subagents: Map<string, LookIslandSubagentSnapshot>;
	usagePercent: number | null;
	usageTokens: number | null;
	usageContextWindow: number | null;
	destroyedAt: number | null;
	startedAt: number;
	lastActivityAt: number;
}

export interface LookIslandState {
	sessions: Map<string, LookIslandSessionState>;
	/** Completed sessions the user already viewed — tombstone so late/replayed
	 * activate snapshots cannot revive them as running ghosts. */
	viewedCompleted: Set<string>;
	appFocused: boolean;
	visibleSessionId: string | null;
	/** Whether the island is manually expanded (clicked the pill). */
	expanded: boolean;
	/** Blocking approval card (permission / plan review). */
	blockingInteraction: LookIslandInteraction | null;
	/** Idle pill feedback shown briefly after enable (millis until). */
	idleFeedbackUntil: number;
}

export function createLookIslandState(): LookIslandState {
	return {
		sessions: new Map(),
		viewedCompleted: new Set(),
		appFocused: true,
		visibleSessionId: null,
		expanded: false,
		blockingInteraction: null,
		idleFeedbackUntil: 0,
	};
}

export function resetLookIslandState(state: LookIslandState): void {
	state.sessions.clear();
	state.viewedCompleted.clear();
	state.appFocused = true;
	state.visibleSessionId = null;
	state.expanded = false;
	state.blockingInteraction = null;
	state.idleFeedbackUntil = 0;
}

/** Briefly show the idle pill (enable feedback). */
export function showLookIslandIdleFeedback(state: LookIslandState, until: number): boolean {
	if (state.idleFeedbackUntil === until) return false;
	state.idleFeedbackUntil = until;
	return true;
}

/** User clicked the pill — expand the island into its card form. */
export function requestLookIslandExpand(state: LookIslandState): boolean {
	if (state.expanded) return false;
	state.expanded = true;
	return true;
}

/** Collapse the island back to the compact pill (outside click / focus session). */
export function collapseLookIsland(state: LookIslandState): boolean {
	if (!state.expanded) return false;
	state.expanded = false;
	return true;
}

export function setLookIslandAppFocused(state: LookIslandState, focused: boolean): boolean {
	if (state.appFocused === focused) return false;
	state.appFocused = focused;
	return true;
}

const MAX_ACTIVITY_LINES = 6;
const LOOK_ISLAND_USAGE_WARNING_PERCENT = 85;
const LOOK_ISLAND_DESTROYED_TTL_MS = 5 * 60_000;
const LOOK_ISLAND_MAX_SESSIONS = 20;

/**
 * Applies a main→renderer event. Returns true when the display snapshot
 * may have changed and the service should re-publish.
 */
export function applyLookIslandEvent(state: LookIslandState, event: MainToRendererEvent, now: number): boolean {
	switch (event.type) {
		case "session:snapshot": {
			// A completed session the user already viewed must not be revived by
			// late/replayed activate snapshots (e.g. the partial + deferred full
			// snapshot pair for long sessions). Only a genuinely new run (streaming
			// snapshot) or a fresh agent_end re-establishes it on the island.
			if (state.viewedCompleted.has(event.sessionId) && !state.sessions.has(event.sessionId)) {
				if (!event.runtime.isStreaming && event.reason !== "agent_end") {
					return false;
				}
				state.viewedCompleted.delete(event.sessionId);
			}
			const session = getOrCreateSession(state, event.sessionId, now);
			const streaming = event.runtime.isStreaming;
			const detail = streamingDetailFromSnapshot(event);
			if (streaming) {
				session.phase = "running";
				session.interactionKind = undefined;
				if (detail) {
					session.detail = detail;
				}
			}
			const model = event.runtime.model;
			if (model) {
				const label = typeof model.name === "string" && model.name.trim() ? model.name.trim() : model.id;
				if (label) session.modelLabel = label;
			}
			const usage = event.runtime.contextUsage;
			// contextUsage fields may be null after compaction (SDK returns null
			// until the next LLM response) — clear instead of keeping stale values.
			if (usage) {
				session.usagePercent = finiteOrNull(usage.percent);
				session.usageTokens = finiteOrNull(usage.tokens);
				session.usageContextWindow = finiteOrNull(usage.contextWindow);
			}
			session.lastActivityAt = now;
			if (event.reason === "agent_end") {
				session.phase = "completed";
				session.detail = session.detail || "Completed";
				// User is actively watching this session (activated + app focused) —
				// completion is already "read", drop it so it never surfaces as an
				// unread badge later (tombstoned against activate-snapshot revival).
				if (state.visibleSessionId === event.sessionId && state.appFocused) {
					state.sessions.delete(event.sessionId);
					state.viewedCompleted.add(event.sessionId);
					if (state.sessions.size === 0 && state.expanded) {
						state.expanded = false;
					}
					return true;
				}
				session.attention = true;
			}
			// User opened this session — viewed. Completed sessions leave the
			// island entirely; live sessions just drop their unread flag.
			if (event.reason === "activate") {
				state.visibleSessionId = event.sessionId;
				return markLookIslandSessionViewed(state, event.sessionId);
			}
			return true;
		}

		case "session:ui-event": {
			const session = getOrCreateSession(state, event.sessionId, now);
			const toolEvent = event.events.find((e) => e.type === "toolcall_start" || e.type === "toolcall_end");
			if (toolEvent?.toolName) {
				session.phase = "running";
				session.interactionKind = undefined;
				session.detail = toolEvent.toolName;
				pushActivityLine(session, {
					id: toolEvent.toolCallId ?? `tool-${now}`,
					kind: "tool",
					text: toolEvent.toolName,
				});
			}
			session.lastActivityAt = now;
			return true;
		}

		case "permission:ask": {
			const session = getOrCreateSession(state, event.agentId, now);
			session.phase = "needs-interaction";
			session.interactionKind = "permission";
			session.permissionToolName = event.event.toolName;
			session.detail = event.event.toolDescription || event.event.toolName;
			session.attention = true;
			session.lastActivityAt = now;
			state.blockingInteraction = {
				kind: "permission",
				requestId: event.event.requestId,
				sessionId: event.agentId,
				toolName: event.event.toolName,
				toolDescription: event.event.toolDescription || event.event.toolName,
				canAllowForSession: true,
			};
			return true;
		}

		case "permission:resolved": {
			const session = state.sessions.get(event.agentId);
			if (session) {
				if (session.interactionKind === "permission" && session.permissionToolName) {
					session.permissionToolName = null;
					session.phase = "running";
					session.interactionKind = undefined;
				}
				session.lastActivityAt = now;
			}
			if (
				state.blockingInteraction?.kind === "permission" &&
				state.blockingInteraction.requestId === event.requestId
			) {
				state.blockingInteraction = null;
			}
			return true;
		}

		case "plan:approval-requested": {
			const session = getOrCreateSession(state, event.agentId, now);
			session.phase = "needs-interaction";
			session.interactionKind = "plan_review";
			session.detail = "Awaiting plan review";
			session.attention = true;
			session.lastActivityAt = now;
			state.blockingInteraction = {
				kind: "plan",
				requestId: event.request.requestId,
				sessionId: event.agentId,
				title: event.request.title ?? "Plan review",
			};
			return true;
		}

		case "plan:question-requested": {
			const session = getOrCreateSession(state, event.agentId, now);
			session.phase = "needs-interaction";
			session.interactionKind = "ask_user_question";
			session.detail = "Awaiting your reply";
			session.attention = true;
			session.lastActivityAt = now;
			return true;
		}

		case "plan:approval-resolved":
		case "plan:question-resolved": {
			const session = state.sessions.get(event.agentId);
			if (session) {
				if (session.phase === "needs-interaction") {
					session.phase = "running";
					session.interactionKind = undefined;
					session.detail = "";
				}
				session.lastActivityAt = now;
			}
			if (state.blockingInteraction?.kind === "plan" && state.blockingInteraction.requestId === event.requestId) {
				state.blockingInteraction = null;
			}
			return true;
		}

		case "session:subagent-progress":
		case "session:subagent-completed": {
			const session = getOrCreateSession(state, event.parentSessionId, now);
			const status = event.type === "session:subagent-completed" ? event.result.status : event.status;
			const model = event.type === "session:subagent-completed" ? event.result.model : event.model;
			const agentName = event.agentName;
			session.subagents.set(event.toolCallId, {
				toolCallId: event.toolCallId,
				agentName: agentName || event.taskTitle || "Sub-agent",
				taskTitle: event.taskTitle,
				status,
				...(typeof model === "string" && model.trim() ? { model } : {}),
			});
			if (status === "running") {
				session.phase = "running";
				session.detail = event.taskTitle || "Running sub-agents";
			}
			session.lastActivityAt = now;
			return true;
		}

		case "agent:context-usage": {
			const session = getOrCreateSession(state, event.agentId, now);
			const usage = event.contextUsage;
			// Same null-clearing semantics as the snapshot path (compaction resets).
			session.usagePercent = finiteOrNull(usage.percent);
			session.usageTokens = finiteOrNull(usage.tokens);
			session.usageContextWindow = finiteOrNull(usage.contextWindow);
			session.lastActivityAt = now;
			return true;
		}

		case "session:activated": {
			// Track the session the user is actively viewing (read semantics
			// for agent_end). Completed sessions leave the island entirely;
			// live sessions just drop their unread flag.
			state.visibleSessionId = event.agentId;
			return markLookIslandSessionViewed(state, event.agentId);
		}

		case "notification:activate-session": {
			// Island jump / notification click — same "user opened this" semantics.
			state.visibleSessionId = event.agentId;
			return markLookIslandSessionViewed(state, event.agentId);
		}

		case "error": {
			if (!event.agentId) return false;
			const session = getOrCreateSession(state, event.agentId, now);
			session.phase = "error";
			session.detail = event.message || "Error";
			session.attention = true;
			session.lastActivityAt = now;
			return true;
		}

		case "agent:created": {
			const session = getOrCreateSession(state, event.agentId, now);
			const name = event.agent.name?.trim();
			if (name) session.title = name;
			return true;
		}

		case "agent:updated": {
			const session = getOrCreateSession(state, event.agentId, now);
			const name = event.agent.name?.trim();
			if (name) session.title = name;
			return true;
		}

		case "agent:destroyed": {
			const session = state.sessions.get(event.agentId);
			// Session lifecycle is over — its viewed tombstone is no longer needed.
			state.viewedCompleted.delete(event.agentId);
			if (session) {
				if (session.phase !== "error") {
					session.phase = "completed";
					session.attention = true;
				}
				session.destroyedAt = now;
				session.subagents.clear();
				session.lastActivityAt = now;
			}
			// Never leave a blocking card for a session that no longer exists.
			if (
				state.blockingInteraction &&
				state.blockingInteraction.kind === "permission" &&
				state.blockingInteraction.sessionId === event.agentId
			) {
				state.blockingInteraction = null;
			}
			if (
				state.blockingInteraction &&
				state.blockingInteraction.kind === "plan" &&
				state.blockingInteraction.sessionId === event.agentId
			) {
				state.blockingInteraction = null;
			}
			return true;
		}

		case "todo:update": {
			const session = state.sessions.get(event.sessionId);
			if (!session) return false;
			const pending = event.items.filter((item) => !item.done);
			if (pending.length > 0) {
				session.phase = "running";
				session.detail = `${pending.length} tasks pending`;
			}
			session.lastActivityAt = now;
			return true;
		}

		default:
			return false;
	}
}

function getOrCreateSession(state: LookIslandState, sessionId: string, now: number): LookIslandSessionState {
	const existing = state.sessions.get(sessionId);
	if (existing) return existing;
	const session: LookIslandSessionState = {
		sessionId,
		title: null,
		projectName: null,
		detail: "",
		phase: "running",
		modelLabel: null,
		permissionToolName: null,
		attention: false,
		activityLines: [],
		subagents: new Map(),
		usagePercent: null,
		usageTokens: null,
		usageContextWindow: null,
		destroyedAt: null,
		startedAt: now,
		lastActivityAt: now,
	};
	state.sessions.set(sessionId, session);
	return session;
}

/**
 * User actually opened this session. The island only represents live
 * sessions plus unread completed ones — once a completed session has been
 * viewed it no longer needs island representation, so drop it entirely.
 * A plain "read" flag would leave the stale session visible whenever the
 * app loses focus. Live sessions (running / needs-interaction / error)
 * stay on the island.
 */
function markLookIslandSessionViewed(state: LookIslandState, sessionId: string): boolean {
	const session = state.sessions.get(sessionId);
	if (!session) return false;
	if (session.phase === "completed") {
		state.sessions.delete(sessionId);
		// Tombstone the session so a replayed/duplicate activate snapshot cannot
		// resurrect it as a running ghost (see session:snapshot guard).
		state.viewedCompleted.add(sessionId);
		if (state.sessions.size === 0 && state.expanded) {
			state.expanded = false;
		}
		return true;
	}
	if (session.attention) {
		session.attention = false;
		return true;
	}
	return false;
}

function pushActivityLine(session: LookIslandSessionState, line: LookIslandActivityLine): void {
	session.activityLines.push(line);
	if (session.activityLines.length > MAX_ACTIVITY_LINES) {
		session.activityLines = session.activityLines.slice(-MAX_ACTIVITY_LINES);
	}
}

/** Coerce a context-usage field to a finite number, or null when absent/invalid. */
function finiteOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function streamingDetailFromSnapshot(event: Extract<MainToRendererEvent, { type: "session:snapshot" }>): string | null {
	const entries = event.entries;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				const content = (message as { content?: unknown }).content;
				if (Array.isArray(content)) {
					for (const block of content as Array<Record<string, unknown>>) {
						if (block.type === "tool_use" && typeof block.name === "string") {
							return block.name;
						}
					}
				}
			}
		}
	}
	return null;
}

/**
 * Bounds the session map: destroyed sessions are evicted after a TTL (keeps
 * the unread-completed badge meaningful without unbounded growth), and the
 * total map is capped so payloads never balloon. Call before building a
 * display state.
 */
export function pruneLookIslandSessions(state: LookIslandState, now: number): boolean {
	let changed = false;
	for (const [sessionId, session] of state.sessions) {
		const expired = session.destroyedAt !== null && now - session.destroyedAt > LOOK_ISLAND_DESTROYED_TTL_MS;
		if (expired) {
			state.sessions.delete(sessionId);
			changed = true;
		}
	}
	if (state.sessions.size > LOOK_ISLAND_MAX_SESSIONS) {
		const excess = [...state.sessions.values()]
			.sort((a, b) => a.lastActivityAt - b.lastActivityAt)
			.slice(0, state.sessions.size - LOOK_ISLAND_MAX_SESSIONS);
		for (const session of excess) {
			state.sessions.delete(session.sessionId);
		}
		changed = true;
	}
	return changed;
}

// ── Snapshot building ───────────────────────────────────────────────

export interface LookIslandDisplayOptions {
	appFocused: boolean;
}

export function buildLookIslandPillSnapshot(sessions: Iterable<LookIslandSessionState>): LookIslandPillSnapshot {
	let activeSessionCount = 0;
	let pendingInteractionCount = 0;
	let unreadCompletedCount = 0;

	// Higher wins for the pill's priority face: interaction requests always
	// outrank plain progress, so the user never misses something that needs them.
	const priorityOrder: Record<LookIslandPhase, number> = {
		idle: 0,
		completed: 1,
		running: 2,
		error: 3,
		"needs-interaction": 4,
	};

	const all = [...sessions];
	let best: LookIslandSessionState | null = null;
	let usageWarning = false;
	for (const session of all) {
		if (session.phase === "running") activeSessionCount += 1;
		if (session.phase === "needs-interaction") {
			activeSessionCount += 1;
			pendingInteractionCount += 1;
		}
		if (session.phase === "error") activeSessionCount += 1;
		if (session.phase === "completed" && session.attention) unreadCompletedCount += 1;
		if (session.usagePercent != null && session.usagePercent >= LOOK_ISLAND_USAGE_WARNING_PERCENT) {
			usageWarning = true;
		}
		if (!best || priorityOrder[session.phase] > priorityOrder[best.phase]) {
			best = session;
		}
	}

	const phase = best?.phase ?? "idle";
	return {
		phase,
		priorityTitle: best ? priorityTitleFor(best) : "",
		sessionCount: all.length,
		activeSessionCount,
		pendingInteractionCount,
		unreadCompletedCount,
		usageWarning,
	};
}

function priorityTitleFor(session: LookIslandSessionState): string {
	if (session.detail) return session.detail;
	switch (session.phase) {
		case "running":
			return "Running";
		case "needs-interaction":
			return "Needs input";
		case "completed":
			return "Completed";
		case "error":
			return "Error";
		default:
			return "";
	}
}

export function buildLookIslandDisplayState(
	state: LookIslandState,
	options: LookIslandDisplayOptions,
	now: number,
): LookIslandDisplayState {
	const sessions = [...state.sessions.values()];
	const pill = buildLookIslandPillSnapshot(sessions);

	const hasBlocking = state.blockingInteraction !== null;
	const idleFeedback = now < state.idleFeedbackUntil;
	const visible = (sessions.length > 0 && (!options.appFocused || state.expanded || hasBlocking)) || idleFeedback;
	const mode: LookIslandDisplayState["mode"] = state.expanded || hasBlocking ? "expanded" : "compact";
	const displayPolicy: LookIslandDisplayPolicy = hasBlocking
		? "blocking"
		: state.expanded
			? "manualExpanded"
			: visible
				? "peek"
				: "closed";
	const prioritySession =
		sessions.find((session) => session.phase === "needs-interaction") ??
		sessions.find((session) => session.phase === "running") ??
		sessions.find((session) => session.phase === "error") ??
		sessions[0];

	const snapshots: LookIslandSessionSnapshot[] = sessions.map((session) => ({
		sessionId: session.sessionId,
		title: session.title,
		projectName: session.projectName,
		detail: session.detail,
		phase: session.phase,
		modelLabel: session.modelLabel,
		...(session.interactionKind ? { interactionKind: session.interactionKind } : {}),
		permissionToolName: session.permissionToolName,
		attention: session.attention,
		activityLines: session.activityLines,
		...(session.subagents.size > 0 ? { subagents: [...session.subagents.values()] } : {}),
		...(session.usagePercent != null ? { usagePercent: session.usagePercent } : {}),
		...(session.usageTokens != null ? { usageTokens: session.usageTokens } : {}),
		...(session.usageContextWindow != null ? { usageContextWindow: session.usageContextWindow } : {}),
		startedAt: session.startedAt,
		lastActivityAt: session.lastActivityAt,
	}));

	return {
		visible,
		mode,
		notchStatus: hasBlocking || state.expanded ? "expanded" : visible ? "peek" : "closed",
		displayPolicy,
		currentSessionId: prioritySession?.sessionId ?? null,
		pillSnapshot: pill,
		sessions: snapshots,
		interaction: state.blockingInteraction,
		strings: { ...DEFAULT_LOOK_ISLAND_STRINGS },
		updatedAt: now,
	};
}
