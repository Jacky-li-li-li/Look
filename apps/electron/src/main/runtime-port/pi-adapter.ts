// ============================================================
// PiAdapter — RuntimePort implementation wrapping the existing pi path
//
// Phase 3b: production send/abort (and create when engine payload is supplied)
// go through this Port. Lifecycle coordinator still owns bind/event wiring;
// Session*Service no longer imports @earendil-works/pi-* directly.
// ============================================================

import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime, SessionManager, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { RuntimeFactoryOptions, SessionRuntimeFactory } from "../session/runtime/runtime-factory.js";
import {
	type ApprovalDecision,
	type CreateSessionInput,
	type EngineSessionRef,
	type LookSessionEvent,
	PI_ENGINE_CAPABILITIES,
	type RuntimePort,
	type Unsubscribe,
	type UserMessage,
} from "./types.js";

/** Engine-private create payload for PiAdapter (narrowed from CreateSessionInput.engine). */
export interface PiEngineCreateOptions {
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	factoryOptions?: RuntimeFactoryOptions;
}

export interface PiAdapterDependencies {
	factory: Pick<SessionRuntimeFactory, "create">;
	/** Resolve a live pi runtime by session id (usually RuntimeRegistry). */
	getRuntime(sessionId: string): AgentSessionRuntime | undefined;
	/**
	 * Optional host-owned dispose (lifecycle coordinator). When omitted,
	 * falls back to `runtime.dispose()` for unit tests / direct Port use.
	 */
	disposeSession?(sessionId: string): Promise<void>;
	/**
	 * Optional resume / ensure path. When omitted, resume is a no-op if the
	 * runtime is already live and throws otherwise.
	 */
	resumeSession?(sessionId: string): Promise<void>;
	/** Feed a Look permission decision into the permission service. */
	resolvePermission(decision: ApprovalDecision): boolean | Promise<boolean>;
}

function isPiEngineCreateOptions(value: unknown): value is PiEngineCreateOptions {
	if (!value || typeof value !== "object") return false;
	return "sessionManager" in value && (value as PiEngineCreateOptions).sessionManager != null;
}

/**
 * Default-engine adapter: every call delegates into the existing pi factory /
 * live AgentSessionRuntime. No behavior fork from the pre-Port path.
 */
export class PiAdapter implements RuntimePort {
	readonly engineId = "pi" as const;
	readonly capabilities = PI_ENGINE_CAPABILITIES;

	constructor(private readonly deps: PiAdapterDependencies) {}

	async create(input: CreateSessionInput): Promise<EngineSessionRef> {
		if (!isPiEngineCreateOptions(input.engine)) {
			throw new Error(
				"[PiAdapter] create() requires engine: PiEngineCreateOptions (sessionManager). " +
					"Phase 1 keeps SessionManager construction in the lifecycle/session services.",
			);
		}
		const { sessionManager, sessionStartEvent, factoryOptions } = input.engine;
		const runtime = await this.deps.factory.create(input.cwd, sessionManager, sessionStartEvent, factoryOptions);
		return {
			engineId: this.engineId,
			sessionId: runtime.session.sessionId,
		};
	}

	async resume(ref: EngineSessionRef): Promise<void> {
		this.assertPiRef(ref);
		if (this.deps.getRuntime(ref.sessionId)) return;
		if (this.deps.resumeSession) {
			await this.deps.resumeSession(ref.sessionId);
			return;
		}
		throw new Error(`[PiAdapter] No live runtime for session ${ref.sessionId} and resumeSession is not wired`);
	}

	async dispose(ref: EngineSessionRef): Promise<void> {
		this.assertPiRef(ref);
		if (this.deps.disposeSession) {
			await this.deps.disposeSession(ref.sessionId);
			return;
		}
		const runtime = this.deps.getRuntime(ref.sessionId);
		if (!runtime) return;
		await runtime.dispose();
	}

	async send(ref: EngineSessionRef, message: UserMessage): Promise<void> {
		this.assertPiRef(ref);
		const session = this.requireRuntime(ref.sessionId).session;
		await session.prompt(message.text, {
			images: message.images as ImageContent[] | undefined,
			source: "rpc",
			streamingBehavior: message.streamingBehavior,
			preflightResult: message.onPreflight,
		});
	}

	async abort(ref: EngineSessionRef): Promise<void> {
		this.assertPiRef(ref);
		const runtime = this.deps.getRuntime(ref.sessionId);
		if (!runtime) return;
		await runtime.session.abort();
	}

	/**
	 * Phase 1 seam: production UI events still flow through SessionEventProcessor.
	 * This subscribe attaches to the live pi session for Port consumers / tests;
	 * raw AgentSessionEvent is not a LookSessionEvent — sinks here receive nothing
	 * until a translator is wired. Returns a real unsubscribe against the session.
	 */
	subscribe(ref: EngineSessionRef, _sink: (event: LookSessionEvent) => void): Unsubscribe {
		this.assertPiRef(ref);
		const session = this.requireRuntime(ref.sessionId).session;
		// Keep the subscription registered so unsubscribe is meaningful; event
		// mapping into LookSessionEvent remains owned by SessionEventProcessor
		// until Phase 2 redirects the production path through the Port.
		return session.subscribe(() => {
			/* Phase 1: mapping deferred — see docs/runtime-adapter.md */
		});
	}

	async resolveToolApproval(_ref: EngineSessionRef, decision: ApprovalDecision): Promise<void> {
		// Permission gate is Look-owned; engine id on ref is validated for API symmetry.
		this.assertPiRef(_ref);
		await this.deps.resolvePermission(decision);
	}

	private assertPiRef(ref: EngineSessionRef): void {
		if (ref.engineId !== "pi") {
			throw new Error(`[PiAdapter] Ref engineId "${ref.engineId}" is not "pi"`);
		}
	}

	private requireRuntime(sessionId: string): AgentSessionRuntime {
		const runtime = this.deps.getRuntime(sessionId);
		if (!runtime) {
			throw new Error(`[PiAdapter] No live runtime for session ${sessionId}`);
		}
		return runtime;
	}
}
