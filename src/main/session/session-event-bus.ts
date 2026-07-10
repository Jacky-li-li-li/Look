// ============================================================
// SessionEventBus — process-local main-to-renderer event fan-out
//
// This is deliberately transport-agnostic. Electron IPC, IM bridges and
// domain services only depend on the IEventBus contract, so replacing the
// renderer transport does not require changing session orchestration.
// ============================================================

import type { EventCallback, MainToRendererEvent } from "@look/shared/types";
import type { IEventBus } from "../core/contracts.js";

export class SessionEventBus implements IEventBus {
	private readonly subscribers = new Set<EventCallback>();

	onEvent(callback: EventCallback): () => void {
		this.subscribers.add(callback);
		return () => this.subscribers.delete(callback);
	}

	emit(event: MainToRendererEvent): void {
		// Snapshotting protects dispatch when a subscriber unsubscribes itself
		// (or another subscriber) while this event is being delivered.
		for (const callback of [...this.subscribers]) callback(event);
	}

	clear(): void {
		this.subscribers.clear();
	}

	get size(): number {
		return this.subscribers.size;
	}
}
