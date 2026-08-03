// ============================================================
// SerialTail — 按 key 串行化异步任务（tail gate 链）
//
// 同一 key 上的任务依次执行：后到者等待前一个完成（含其 tail gate）
// 后再运行。用于替换此前 runtime-registry.withExclusive 与
// runtime-factory.withResourceInitialization 两份手写的 gate 链。
// ============================================================

export class SerialTail<TKey> {
	private tails = new Map<TKey, Promise<unknown>>();

	/** 串行执行 task；同一 key 的并发调用按调用顺序排队。 */
	run<T>(key: TKey, task: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => gate);
		this.tails.set(key, tail);

		return (async () => {
			await previous;
			try {
				return await task();
			} finally {
				release();
				if (this.tails.get(key) === tail) this.tails.delete(key);
			}
		})();
	}

	/** 放弃某个 key 上排队中的任务（清空 tail，让后续调用立即执行）。 */
	release(key: TKey): void {
		this.tails.delete(key);
	}
}
