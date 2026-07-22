// ============================================================
// UI Event Pipeline — rAF-batched scheduling of per-token
// LookUiEvent streams to the Jotai store.
//
// Scheduling layer only. Event application (the state machine) is in
// ui-event-applier.ts. Together they reduce IPC updates from token-rate
// to ≤ framerate, eliminating per-token React re-render storms.
// ============================================================

import type { LookUiEvent } from "@shared/types";
import { applyUiEventBatch } from "./ui-event-applier";

// ── Pipeline queues ──

/** Per-session pending event queue — one frame's worth of events. */
const pendingQueues = new Map<string, LookUiEvent[]>();

/** Sessions that already have a rAF (or fallback timeout) flush scheduled. */
const scheduledSessions = new Set<string>();

/** Max-latency fallback timers for background tabs (rAF doesn't fire when hidden). */
const fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();

const MAX_FLUSH_LATENCY_MS = 16;

// ── Terminal event detection ──

function isTerminalEvent(e: LookUiEvent): boolean {
	if (e.type === "error" || e.type === "assistant_message_end") return true;
	if (e.type === "run_status" && e.status !== "streaming" && e.status !== "working") return true;
	if (e.type === "retry_status" && e.status === "end") return true;
	if (e.type === "compacting" && !e.active) return true;
	return false;
}

// ── rAF scheduling ──

function cancelFallback(sessionId: string): void {
	const timer = fallbackTimers.get(sessionId);
	if (timer) {
		clearTimeout(timer);
		fallbackTimers.delete(sessionId);
	}
}

function flushSession(sessionId: string): void {
	scheduledSessions.delete(sessionId);
	cancelFallback(sessionId);
	const events = pendingQueues.get(sessionId);
	if (!events || events.length === 0) return;
	pendingQueues.delete(sessionId);
	applyUiEventBatch(sessionId, events);
}

function scheduleFlush(sessionId: string): void {
	if (scheduledSessions.has(sessionId)) return;
	scheduledSessions.add(sessionId);

	// In Node.js test environments, requestAnimationFrame is unavailable.
	if (typeof requestAnimationFrame !== "function") return;

	const rafId = requestAnimationFrame(() => {
		cancelFallback(sessionId);
		flushSession(sessionId);
	});

	const timer = setTimeout(() => {
		if (scheduledSessions.has(sessionId)) {
			cancelAnimationFrame(rafId);
			flushSession(sessionId);
		}
	}, MAX_FLUSH_LATENCY_MS);
	fallbackTimers.set(sessionId, timer);
}

// ── Public API ──

export function enqueueUiEvent(sessionId: string, events: LookUiEvent[]): void {
	if (events.length === 0) return;

	// Terminal events → flush immediately.
	// Drain any queued events first to preserve ordering.
	if (events.some(isTerminalEvent)) {
		const pending = pendingQueues.get(sessionId);
		if (pending && pending.length > 0) {
			pendingQueues.delete(sessionId);
			scheduledSessions.delete(sessionId);
			cancelFallback(sessionId);
			applyUiEventBatch(sessionId, pending);
		}
		applyUiEventBatch(sessionId, events);
		return;
	}

	const existing = pendingQueues.get(sessionId);
	if (existing) {
		existing.push(...events);
	} else {
		pendingQueues.set(sessionId, [...events]);
	}
	scheduleFlush(sessionId);
}

/** 测试辅助：同步 drain 所有待处理队列。 */
export function flushAllUiEvents(): void {
	const dirtyIds = [...pendingQueues.keys()];
	for (const id of dirtyIds) {
		scheduledSessions.delete(id);
		cancelFallback(id);
		const events = pendingQueues.get(id);
		pendingQueues.delete(id);
		if (events && events.length > 0) {
			applyUiEventBatch(id, events);
		}
	}
}

/** Clear all scheduling state for a destroyed session. */
export function clearSessionScheduling(sessionId: string): void {
	scheduledSessions.delete(sessionId);
	cancelFallback(sessionId);
	pendingQueues.delete(sessionId);
}

/** Exported for test introspection. */
export function getScheduledSessions(): ReadonlySet<string> {
	return scheduledSessions;
}
export function getFallbackTimers(): ReadonlyMap<string, ReturnType<typeof setTimeout>> {
	return fallbackTimers;
}
export function getPendingQueues(): ReadonlyMap<string, LookUiEvent[]> {
	return pendingQueues;
}
