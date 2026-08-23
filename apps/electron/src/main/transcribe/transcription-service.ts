// ============================================================
// Transcribe — 转写服务（单模型驻留 + 串行队列）
//
// 从 pi-transcribe 的 TranscriptionService 精简移植（MIT）：
//   - 一个已加载模型常驻，切换模型自动卸载/加载
//   - 任务串行执行（transcribe.cpp 会话不并发），支持中止
//   - 听写优先级队列 Phase 2 再加；当前只有文件任务队列
// ============================================================

import type { ChineseOutput } from "./settings.js";
import type { TranscribeCppBackend } from "./transcription.js";

type ReusableBackend = Pick<TranscribeCppBackend, "prepare" | "transcribe" | "dispose">;
type BackendFactory = (modelPath: string) => ReusableBackend | Promise<ReusableBackend>;

export type TranscribeJob = {
	modelPath: string;
	pcm: Float32Array;
	signal?: AbortSignal;
	language?: string;
	chineseOutput?: ChineseOutput;
	resolve: (text: string) => void;
	reject: (error: unknown) => void;
	started: boolean;
	settled: boolean;
	removeAbortListener?: () => void;
};

/** 队列空闲后保留模型的时长：避免连续任务反复重载（重载一次约 0.5~1s），
 *  同时也避免模型长期驻留占用内存。 */
const IDLE_UNLOAD_MS = 15_000;

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Transcription cancelled");
}

export class TranscriptionService {
	private backend: ReusableBackend | undefined;
	private modelPath: string | undefined;
	private readonly queue: TranscribeJob[] = [];
	private loop: Promise<void> | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private shuttingDown = false;
	private readonly shutdownController = new AbortController();

	constructor(
		private readonly createBackend: BackendFactory = async (modelPath) => {
			const { TranscribeCppBackend } = await import("./transcription.js");
			return new TranscribeCppBackend(modelPath);
		},
	) {}

	transcribeFile(
		modelPath: string,
		pcm: Float32Array,
		options: { signal?: AbortSignal; language?: string; chineseOutput?: ChineseOutput } = {},
	): Promise<string> {
		if (this.shuttingDown) return Promise.reject(new Error("transcribe service is shutting down"));
		if (options.signal?.aborted) return Promise.reject(abortError(options.signal));

		return new Promise<string>((resolve, reject) => {
			const job: TranscribeJob = {
				modelPath,
				pcm,
				signal: options.signal,
				language: options.language,
				chineseOutput: options.chineseOutput,
				resolve,
				reject,
				started: false,
				settled: false,
			};
			if (options.signal) {
				const onAbort = (): void => {
					if (job.started || job.settled) return;
					this.removeQueuedJob(job);
					this.settleJob(job, () => reject(abortError(options.signal!)));
					this.schedule();
				};
				options.signal.addEventListener("abort", onAbort, { once: true });
				job.removeAbortListener = () => options.signal!.removeEventListener("abort", onAbort);
			}
			this.queue.push(job);
			this.schedule();
		});
	}

	private removeQueuedJob(job: TranscribeJob): void {
		const index = this.queue.indexOf(job);
		if (index >= 0) this.queue.splice(index, 1);
	}

	private settleJob(job: TranscribeJob, settle: () => void): void {
		if (job.settled) return;
		job.settled = true;
		job.removeAbortListener?.();
		settle();
	}

	private clearIdleUnload(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
	}

	private schedule(): void {
		if (this.loop) return;
		const loop = this.process().finally(() => {
			if (this.loop === loop) this.loop = undefined;
			if (this.queue.length > 0 && !this.shuttingDown) this.schedule();
		});
		this.loop = loop;
	}

	private async process(): Promise<void> {
		while (!this.shuttingDown) {
			const job = this.queue.shift();
			if (!job) {
				// 队列空闲：保留模型一段时间（空闲窗口），窗口内新任务直接复用。
				if (!this.idleTimer) {
					this.idleTimer = setTimeout(() => {
						this.idleTimer = undefined;
						void this.unloadModel().catch(() => undefined);
					}, IDLE_UNLOAD_MS);
					this.idleTimer.unref?.();
				}
				return;
			}
			this.clearIdleUnload();
			await this.runJob(job);
		}
	}

	private async runJob(job: TranscribeJob): Promise<void> {
		if (job.settled) return;
		job.started = true;
		const signal = job.signal
			? AbortSignal.any([job.signal, this.shutdownController.signal])
			: this.shutdownController.signal;

		try {
			signal.throwIfAborted();
			const backend = await this.ensureModel(job.modelPath);
			signal.throwIfAborted();
			const text = await backend.transcribe(job.pcm, {
				signal,
				language: job.language,
				chineseOutput: job.chineseOutput,
			});
			this.settleJob(job, () => job.resolve(text));
		} catch (error) {
			this.settleJob(job, () => job.reject(error));
		}
	}

	private async ensureModel(modelPath: string): Promise<ReusableBackend> {
		if (this.backend && this.modelPath === modelPath) {
			await this.backend.prepare();
			return this.backend;
		}
		await this.unloadModel();
		const backend = await this.createBackend(modelPath);
		this.backend = backend;
		this.modelPath = modelPath;
		try {
			await backend.prepare();
			return backend;
		} catch (error) {
			if (this.backend === backend) {
				this.backend = undefined;
				this.modelPath = undefined;
			}
			await backend.dispose().catch(() => undefined);
			throw error;
		}
	}

	private async unloadModel(): Promise<void> {
		const backend = this.backend;
		if (!backend) return;
		this.backend = undefined;
		this.modelPath = undefined;
		await backend.dispose();
	}

	async shutdown(): Promise<void> {
		if (!this.shuttingDown) {
			this.shuttingDown = true;
			this.clearIdleUnload();
			this.shutdownController.abort(new Error("transcribe service is shutting down"));
			const shutdownError = new Error("transcribe service is shutting down");
			for (const job of [...this.queue]) {
				this.settleJob(job, () => job.reject(shutdownError));
			}
			this.queue.length = 0;
		}
		await this.loop?.catch(() => undefined);
		await this.unloadModel().catch(() => undefined);
	}
}

let serviceSingleton: TranscriptionService | undefined;

/** 主进程级转写服务单例（builder 与 IPC router 共用，避免重复加载模型）。 */
export function getTranscriptionService(): TranscriptionService {
	serviceSingleton ??= new TranscriptionService();
	return serviceSingleton;
}
