// ============================================================
// UIEventBatcher — two-stage time-window batching for UI events
//
// Extracted from SessionRuntimeManager. Batches per-token UI events
// before flushing them to the renderer via the event bus.
//
// Two-stage strategy:
//   1. First event after idle → 1ms probe window. If no second event
//      arrives, flush immediately (avoid delaying sparse streams).
//   2. Second event arrives during probe → switch to 8ms batch window
//      (coalesce per-token bursts at ~120fps headroom).
// ============================================================

import type { LookUiEvent } from "@look/shared/types";
import type { IEventBus, ISessionScope } from "../../core/contracts.js";

const UI_EVENT_BATCH_MS = 8;
const UI_EVENT_FIRST_MS = 1;

export class UIEventBatcher {
	constructor(private readonly eventBus: IEventBus) {}

	/** Buffer non-terminal UI events per session for time-window batching. */
	bufferUiEvents(scope: ISessionScope, events: LookUiEvent[]): void {
		if (scope.uiEventBuffer.length > 0) {
			scope.uiEventBuffer.push(...events);
			// A second event arrived during the 1ms first-event probe:
			// switch to the normal 8ms batch window.
			if (scope.uiEventFirstTimer) {
				this.promoteUiEventFlush(scope);
			}
		} else {
			scope.uiEventBuffer = [...events];
		}
		this.scheduleUiEventFlush(scope);
	}

	/** Discard buffered UI events for a session without emitting (destroy cleanup). */
	clearUiEventBuffer(scope: ISessionScope): void {
		if (scope.uiEventFlushTimer) {
			clearTimeout(scope.uiEventFlushTimer);
			scope.uiEventFlushTimer = null;
		}
		if (scope.uiEventFirstTimer) {
			clearTimeout(scope.uiEventFirstTimer);
			scope.uiEventFirstTimer = null;
		}
		scope.uiEventBuffer = [];
	}

	/** Drain the buffered UI events for a session and emit them as one batch. */
	flushUiEventBuffer(scope: ISessionScope): void {
		if (scope.uiEventFlushTimer) {
			clearTimeout(scope.uiEventFlushTimer);
			scope.uiEventFlushTimer = null;
		}
		if (scope.uiEventFirstTimer) {
			clearTimeout(scope.uiEventFirstTimer);
			scope.uiEventFirstTimer = null;
		}
		const events = scope.uiEventBuffer;
		if (events.length === 0) return;
		scope.uiEventBuffer = [];
		this.eventBus.emit({ type: "session:ui-event", sessionId: scope.sessionId, events });
	}

	// ── private ──

	private scheduleUiEventFlush(scope: ISessionScope): void {
		if (scope.uiEventFlushTimer || scope.uiEventFirstTimer) return;
		const firstTimer = setTimeout(() => {
			scope.uiEventFirstTimer = null;
			this.flushUiEventBuffer(scope);
		}, UI_EVENT_FIRST_MS);
		scope.uiEventFirstTimer = firstTimer;
	}

	private promoteUiEventFlush(scope: ISessionScope): void {
		if (scope.uiEventFirstTimer) {
			clearTimeout(scope.uiEventFirstTimer);
			scope.uiEventFirstTimer = null;
		}
		if (scope.uiEventFlushTimer) return;
		const timer = setTimeout(() => {
			scope.uiEventFlushTimer = null;
			this.flushUiEventBuffer(scope);
		}, UI_EVENT_BATCH_MS);
		scope.uiEventFlushTimer = timer;
	}
}
