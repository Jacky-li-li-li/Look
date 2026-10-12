// ============================================================
// Lark chat task queue — serialize work per (appId, chatId)
// Extracted from LarkBridgeService so the bridge class focuses on
// binding lifecycle and reply streaming.
//
// Phase 2: each chat key owns an AbortController. abort / clear /
// clearForApp signal in-flight tasks and skip pending ones.
// ============================================================

function isAbortError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const name = (error as { name?: string }).name;
	return name === "AbortError" || name === "AbortSignal";
}

/**
 * Per-chat serial queue. Concurrent inbound messages for the same chat
 * run one-after-another; a failure does not block the next task.
 * Aborting a key cancels pending work and signals the in-flight task.
 */
export class LarkChatTaskQueue {
	private readonly queues = new Map<string, Promise<void>>();
	/** Live AbortController per chat key (replaced after abort so later enqueues work). */
	private readonly controllers = new Map<string, AbortController>();

	constructor(
		private readonly keyFor: (appId: string, chatId: string) => string,
		private readonly onError: (key: string, error: unknown) => void = (key, error) => {
			console.warn("[LarkChatTaskQueue] Chat task failed:", key, error);
		},
	) {}

	enqueue(appId: string, chatId: string, task: (signal: AbortSignal) => Promise<void>): Promise<void> {
		const key = this.keyFor(appId, chatId);
		const prev = this.queues.get(key) ?? Promise.resolve();
		let controller = this.controllers.get(key);
		if (!controller || controller.signal.aborted) {
			controller = new AbortController();
			this.controllers.set(key, controller);
		}
		const { signal } = controller;
		const run = async (): Promise<void> => {
			if (signal.aborted) return;
			try {
				await task(signal);
			} catch (err) {
				if (signal.aborted || isAbortError(err)) return;
				this.onError(key, err);
			}
		};
		const next = prev.then(run, run);
		this.queues.set(key, next);
		void next.finally(() => {
			if (this.queues.get(key) === next) {
				this.queues.delete(key);
				const ctrl = this.controllers.get(key);
				// Drop idle controller once the chain drains (keep aborted ones cleared by abortKey).
				if (ctrl && !ctrl.signal.aborted && !this.queues.has(key)) {
					this.controllers.delete(key);
				}
			}
		});
		return next;
	}

	/** Abort in-flight work and drop pending tasks for one chat. */
	abort(appId: string, chatId: string): void {
		this.abortKey(this.keyFor(appId, chatId));
	}

	/** 测试/诊断：当前挂起的队列数。 */
	get pendingCount(): number {
		return this.queues.size;
	}

	/** Abort every chat queue (in-flight + pending). */
	clear(): void {
		for (const key of Array.from(this.controllers.keys())) {
			this.abortKey(key);
		}
		// Defensive: drop any orphan queue entries without a controller.
		this.queues.clear();
		this.controllers.clear();
	}

	/** Abort and drop queues for one bot (`appId::` prefix) only. */
	clearForApp(appId: string): void {
		const prefix = `${appId}::`;
		for (const key of Array.from(new Set([...this.controllers.keys(), ...this.queues.keys()]))) {
			if (key.startsWith(prefix)) this.abortKey(key);
		}
	}

	private abortKey(key: string): void {
		const ctrl = this.controllers.get(key);
		if (ctrl && !ctrl.signal.aborted) {
			ctrl.abort();
		}
		this.controllers.delete(key);
		this.queues.delete(key);
	}
}
