// ============================================================
// RuntimePortRegistry — look up RuntimePort by Look session id
//
// Phase 1: a single default PiAdapter serves all sessions.
// Later engines bind per-session without forking Session*Service.
// Does not replace RuntimeRegistry (AgentSessionRuntime consumers).
// ============================================================

import type { RuntimePort } from "./types.js";

export class RuntimePortRegistry {
	private readonly bySession = new Map<string, RuntimePort>();
	private defaultPort: RuntimePort | null = null;

	/** Process-default port (Phase 1: always PiAdapter). */
	setDefault(port: RuntimePort): void {
		this.defaultPort = port;
	}

	getDefault(): RuntimePort | null {
		return this.defaultPort;
	}

	/** Associate a Look session with a specific engine port (multi-engine later). */
	bind(sessionId: string, port: RuntimePort): void {
		this.bySession.set(sessionId, port);
	}

	unbind(sessionId: string): void {
		this.bySession.delete(sessionId);
	}

	/**
	 * Resolve the port for a session. Falls back to the default engine so
	 * existing pi sessions keep working without an explicit bind.
	 */
	get(sessionId: string): RuntimePort | undefined {
		return this.bySession.get(sessionId) ?? this.defaultPort ?? undefined;
	}

	has(sessionId: string): boolean {
		return this.bySession.has(sessionId) || this.defaultPort != null;
	}

	clear(): void {
		this.bySession.clear();
	}
}
