// ============================================================
// Lark chat task queue — serialize work per (appId, chatId)
// Extracted from LarkBridgeService so the bridge class focuses on
// binding lifecycle and reply streaming.
// ============================================================

/**
 * Per-chat serial queue. Concurrent inbound messages for the same chat
 * run one-after-another; a failure does not block the next task.
 */
export class LarkChatTaskQueue {
	private readonly queues = new Map<string, Promise<void>>();

	constructor(
		private readonly keyFor: (appId: string, chatId: string) => string,
		private readonly onError: (key: string, error: unknown) => void = (key, error) => {
			console.warn("[LarkChatTaskQueue] Chat task failed:", key, error);
		},
	) {}

	enqueue(appId: string, chatId: string, task: () => Promise<void>): Promise<void> {
		const key = this.keyFor(appId, chatId);
		const prev = this.queues.get(key) ?? Promise.resolve();
		const run = async (): Promise<void> => {
			try {
				await task();
			} catch (err) {
				this.onError(key, err);
			}
		};
		const next = prev.then(run, run);
		this.queues.set(key, next);
		void next.finally(() => {
			if (this.queues.get(key) === next) this.queues.delete(key);
		});
		return next;
	}

	/** 测试/诊断：当前挂起的队列数。 */
	get pendingCount(): number {
		return this.queues.size;
	}

	clear(): void {
		this.queues.clear();
	}

	/** 删除某 bot（appId:: 前缀）下挂起的队列条目。 */
	clearForApp(appId: string): void {
		const prefix = `${appId}::`;
		for (const key of Array.from(this.queues.keys())) {
			if (key.startsWith(prefix)) this.queues.delete(key);
		}
	}
}
