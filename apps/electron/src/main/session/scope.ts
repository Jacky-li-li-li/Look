// ============================================================
// SessionScope — per-session mutable state aggregator
//
// Each ManagedRuntime gets a SessionScope that centralises all
// per-session mutable state that multiple domain services need to
// read/write. The scope is created in bindRuntime and destroyed in
// disposeRuntime. Services receive the scope via ISessionScopeRegistry
// instead of poking SRT's internal Maps directly.
// ============================================================

import type { LookUiEvent } from "@look/shared/types";
import type { ISessionScope } from "../core/contracts.js";
import type { ContentBlockTracker } from "./event-translator.js";
import { createContentBlockTracker } from "./event-translator.js";

export class SessionScope implements ISessionScope {
	public readonly sessionId: string;
	public readonly projectId: string;

	public uiEventBuffer: LookUiEvent[] = [];
	public uiEventFlushTimer: ReturnType<typeof setTimeout> | null = null;
	public uiEventFirstTimer: ReturnType<typeof setTimeout> | null = null;
	public translationTracker: ContentBlockTracker;
	public isDefaultName = false;
	public turnStartedAt: number | null = null;
	public imProvider?: string;
	/** Captured from CompactionResult.estimatedTokensAfter after session.compact() completes. */
	public compactionEstimatedTokensAfter?: number;

	constructor(sessionId: string, projectId: string) {
		this.sessionId = sessionId;
		this.projectId = projectId;
		this.translationTracker = createContentBlockTracker();
	}
}
