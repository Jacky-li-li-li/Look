// ============================================================
// RuntimeRegistry — live runtime identity, initialization de-duplication
// and per-source-session exclusive operation locks.
//
// It has no pi SDK side effects itself. The owner supplies creation and
// disposal behavior, making this module straightforward to test in isolation.
// ============================================================

import type { AgentSessionRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { SerialTail } from "../../utils/serial-tail.js";

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
	/** Per-session exclusive operation lock（serialize 队列操作，如 remove/insert-queued-message）。 */
	private readonly serial = new SerialTail<string>();

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

	// 初始化失败已由 createManagedRuntime 上报给创建方，这里仅等待 settle，避免重复告警。
	async awaitInitialization(sessionId: string): Promise<void> {
		await this.initializations.get(sessionId)?.catch(() => undefined);
	}

	async awaitAllInitializations(): Promise<void> {
		await Promise.all(
			Array.from(this.initializations.values()).map((initialization) => initialization.catch(() => undefined)),
		);
	}

	async withExclusive<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
		return this.serial.run(sessionId, task);
	}

	releaseExclusive(sessionId: string): void {
		this.serial.release(sessionId);
	}
}
