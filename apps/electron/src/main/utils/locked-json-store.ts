// ============================================================
// LockedJsonStore — 跨进程文件锁 + 进程内串行队列的 JSON 存储
//
// 适用于可能有多个 Look 进程（或进程内并发路径）读改写的
// 状态文件（scheduled-tasks.json、drafts.json 等）。合并了
// ScheduledTaskStore 与 DraftStore 原先逐行重复的基建：
//   - mutation 队列：进程内变更不交叉、不丢更新；
//   - FileTaskLock：跨进程互斥，临界区内重新读盘再合并变更；
//   - 唯一临时文件 + rename 原子落盘（见 atomic-writer）。
// 子类只需提供归一化逻辑（normalizeDatabase）与业务方法。
// ============================================================

import { readJsonFile, writeJsonFileAsync } from "./atomic-writer.js";
import { type AcquiredTaskLock, FileTaskLock } from "./task-lock.js";

export abstract class LockedJsonStore<T extends object> {
	/** 最近一次 load()/mutate() 看到的磁盘状态。 */
	protected database: T;
	private mutationQueue: Promise<void> = Promise.resolve();
	private readonly mutationLock: FileTaskLock;

	protected constructor(
		protected readonly filePath: string,
		emptyDatabase: T,
		protected readonly logTag: string,
	) {
		this.database = structuredClone(emptyDatabase);
		this.mutationLock = new FileTaskLock(`${filePath}.locks`, `${process.pid}:${crypto.randomUUID()}`);
	}

	/** 从磁盘读取（失败回退空库）并归一化为合法的数据库形状。 */
	protected abstract normalizeDatabase(raw: unknown): T;

	/** 重新读盘并归一化；查询方法与跨进程临界区都会调用。 */
	load(): void {
		this.database = this.normalizeDatabase(readJsonFile<unknown>(this.filePath, null));
	}

	/** 串行化变更 + 落盘：队列内加载最新文件、应用变更并等待写盘完成。 */
	protected async mutate<U>(update: (database: T) => U): Promise<U> {
		const operation = this.mutationQueue.then(async () => {
			const lock = await this.acquireMutationLock();
			try {
				// 刷新必须位于跨进程临界区内，避免多个 Look 实例互相覆盖。
				this.load();
				const next = structuredClone(this.database);
				const result = update(next);
				await writeJsonFileAsync(this.filePath, next);
				this.database = next;
				return result;
			} finally {
				await lock.release();
			}
		});

		// 当前调用仍然收到原始错误；队列本身吞掉错误，保证下一次 mutation 可以恢复。
		this.mutationQueue = operation
			.then(() => undefined)
			.catch((error) => {
				console.error(`[${this.logTag}] Mutation failed:`, error);
			});
		return operation;
	}

	private async acquireMutationLock(): Promise<AcquiredTaskLock> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const lock = await this.mutationLock.acquire("database", 30_000);
			if (lock) return lock;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`Timed out waiting for ${this.logTag} storage lock: ${this.filePath}`);
	}

	/** 等待所有待落盘写入完成（测试与退出前收尾用）。 */
	flush(): Promise<void> {
		return this.mutationQueue;
	}
}
