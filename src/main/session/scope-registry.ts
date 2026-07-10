// ============================================================
// SessionScopeRegistry — acquires / releases SessionScope instances
//
// Thin registry that owns the lifecycle of per-session state. When
// bindRuntime creates a scope, the registry holds it. When disposeRuntime
// tears it down, the registry removes it. Domain services look up scopes
// by sessionId without needing to know about SRT internals.
// ============================================================

import type { ISessionScopeRegistry } from "../core/contracts.js";
import { SessionScope } from "./scope.js";

export class SessionScopeRegistry implements ISessionScopeRegistry {
	private readonly scopes = new Map<string, SessionScope>();

	acquire(sessionId: string, projectId: string): SessionScope {
		let scope = this.scopes.get(sessionId);
		if (!scope) {
			scope = new SessionScope(sessionId, projectId);
			this.scopes.set(sessionId, scope);
		}
		return scope;
	}

	release(sessionId: string): void {
		this.scopes.delete(sessionId);
	}

	get(sessionId: string): SessionScope | undefined {
		return this.scopes.get(sessionId);
	}

	has(sessionId: string): boolean {
		return this.scopes.has(sessionId);
	}
}
