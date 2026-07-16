// ============================================================
// RuntimeRegistry — live runtime identity, initialization de-duplication
// and per-source-session exclusive operation locks.
//
// It has no pi SDK side effects itself. The owner supplies creation and
// disposal behavior, making this module straightforward to test in isolation.
// ============================================================

import type { AgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

/** Stable host-owned identity for the session currently bound to a mutable SDK runtime. */
export interface RuntimeSessionBinding {
	readonly sessionId: string;
	readonly sessionManager: SessionManager;
}

export interface ManagedRuntime {
	readonly runtime: AgentSessionRuntime;
	readonly projectId: string;
	/** Immutable cwd captured when this live runtime is registered. */
	readonly cwd: string;
	readonly createdAt: number;
	/** Updated only when a replacement session has been accepted by the host. */
	binding: RuntimeSessionBinding;
	unsubscribe: () => void;
}

export class RuntimeRegistry {
	private readonly runtimes = new Map<string, ManagedRuntime>();
	private readonly initializations = new Map<string, Promise<ManagedRuntime>>();
	private readonly operationTails = new Map<string, Promise<void>>();

	get(sessionId: string): ManagedRuntime | undefined {
		return this.runtimes.get(sessionId);
	}

	has(sessionId: string): boolean {
		return this.runtimes.has(sessionId);
	}

	set(sessionId: string, managed: ManagedRuntime): void {
		this.runtimes.set(sessionId, managed);
	}
	delete(sessionId: string): boolean {
		return this.runtimes.delete(sessionId);
	}

	entries(): IterableIterator<[string, ManagedRuntime]> {
		return this.runtimes.entries();
	}
	values(): IterableIterator<ManagedRuntime> {
		return this.runtimes.values();
	}
	keys(): IterableIterator<string> {
		return this.runtimes.keys();
	}

	async getOrCreate(sessionId: string, create: () => Promise<ManagedRuntime>): Promise<ManagedRuntime> {
		const existing = this.runtimes.get(sessionId);
		if (existing) return existing;
		const initializing = this.initializations.get(sessionId);
		if (initializing) return initializing;
		const initialization = create().finally(() => this.initializations.delete(sessionId));
		this.initializations.set(sessionId, initialization);
		return initialization;
	}

	async awaitInitialization(sessionId: string): Promise<void> {
		await this.initializations.get(sessionId)?.catch(() => undefined);
	}

	async awaitAllInitializations(): Promise<void> {
		await Promise.all(
			Array.from(this.initializations.values()).map((initialization) => initialization.catch(() => undefined)),
		);
	}

	async withExclusive<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.operationTails.get(sessionId) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => gate);
		this.operationTails.set(sessionId, tail);
		await previous;
		try {
			return await task();
		} finally {
			release();
			if (this.operationTails.get(sessionId) === tail) this.operationTails.delete(sessionId);
		}
	}

	releaseExclusive(sessionId: string): void {
		this.operationTails.delete(sessionId);
	}
}
