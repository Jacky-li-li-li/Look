// ============================================================
// SessionScope — per-session mutable state aggregator
//
// Each ManagedRuntime gets a SessionScope that centralises all
// per-session mutable state that multiple domain services need to
// read/write. The scope is created in bindRuntime and destroyed in
// disposeRuntime. Services receive the scope via ISessionScopeRegistry
// instead of poking SRT's internal Maps directly.
// ============================================================

import type { ISessionScope } from "../core/contracts.js";
import type { LookUiEvent } from "../shared/types.js";
import type { ContentBlockTracker } from "./event-translator.js";
import { createContentBlockTracker } from "./event-translator.js";

export class SessionScope implements ISessionScope {
	public readonly sessionId: string;
	public readonly projectId: string;

	public streamingState: "idle" | "streaming" | "retrying" = "idle";
	public uiEventBuffer: LookUiEvent[] = [];
	public uiEventFlushTimer: ReturnType<typeof setTimeout> | null = null;
	public uiEventFirstTimer: ReturnType<typeof setTimeout> | null = null;
	public translationTracker: ContentBlockTracker;
	public isDefaultName = false;
	public turnStartedAt: number | null = null;
	public imProvider?: string;

	constructor(sessionId: string, projectId: string) {
		this.sessionId = sessionId;
		this.projectId = projectId;
		this.translationTracker = createContentBlockTracker();
	}
}
