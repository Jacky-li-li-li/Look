// ============================================================
// LiveStreamController — 流式语音转写（边说边出字）
//
// 与 mic-worker 的 --live 增量输出配合：
//   worker 每 ~400ms 把新音频追加到 live 文件
//   主进程读新增采样 → stream.feed() → committed/tentative 文本
// 停止时 finalize 定稿。模型会话独立管理（不与 TranscriptionService
// 共用驻留模型，语音输入结束即释放）。
//
// 仅支持 streaming 模型（如 nemotron-3.5-asr-streaming-0.6b）；
// 非流式模型走 record-stop 的一次性转写路径。
// ============================================================

import { readFile, rm } from "node:fs/promises";
import { type Session, type Stream, TranscribeModel } from "transcribe-cpp";

export class LiveStreamController {
	private model: TranscribeModel | undefined;
	private session: Session | undefined;
	private stream: Stream | undefined;
	private livePath: string | undefined;
	private feedPromise: Promise<void> = Promise.resolve();
	private lastFed = 0;
	private stopping = false;
	committed = "";
	tentative = "";

	get active(): boolean {
		return this.stream !== undefined;
	}

	/** 启动流式会话并开始 feed 循环。模型加载完成后开始消费 live 文件。 */
	async start(modelPath: string, livePath: string, language?: string): Promise<void> {
		if (this.stream) throw new Error("already streaming");
		this.livePath = livePath;
		this.lastFed = 0;
		this.stopping = false;
		this.committed = "";
		this.tentative = "";
		let loaded: TranscribeModel | undefined;
		try {
			loaded = await TranscribeModel.load(modelPath);
			const session = loaded.createSession();
			const stream = await session.stream(language && language !== "auto" ? { language } : undefined);
			this.model = loaded;
			this.session = session;
			this.stream = stream;
		} catch (error) {
			// 失败自清理：不留驻留模型占用内存；live 临时文件由调用方回滚清理。
			try {
				loaded?.dispose();
			} catch {
				// ignore
			}
			this.livePath = undefined;
			throw error;
		}
		this.scheduleFeed();
	}

	private async pump(stream: Stream, allowStopping = false): Promise<void> {
		if (!this.livePath) return;
		// 常规 feed 循环在 stopping 后停摆；但 stop() 的最终冲刷必须显式放行，
		// 否则 worker 退出前 appendLive(true) 写入的尾部音频（最多 ~1s）永远
		// 进不了流式会话，finalize 定稿会截掉最后一个词。
		if (this.stopping && !allowStopping) return;
		const buf = await readFile(this.livePath).catch(() => null);
		if (!buf || buf.byteLength < 4) return;
		const samples = Math.floor(buf.byteLength / 4);
		if (samples > this.lastFed) {
			// readFile 返回的 Buffer 可能是共享 ArrayBuffer 池的视图，必须带上 byteOffset。
			const chunk = new Float32Array(buf.buffer, buf.byteOffset + this.lastFed * 4, samples - this.lastFed);
			await stream.feed(chunk);
			this.lastFed = samples;
			const snap = stream.text;
			this.committed = snap.committed ?? "";
			this.tentative = snap.tentative ?? "";
		}
	}

	private scheduleFeed(): void {
		const stream = this.stream;
		if (!stream || this.stopping) return;
		this.feedPromise = this.feedPromise
			.then(() => this.pump(stream))
			.catch((error: unknown) => {
				console.error("[transcribe] live feed error:", error);
			})
			.then(() => {
				if (!this.stopping && this.stream === stream) setTimeout(() => this.scheduleFeed(), 400);
			});
	}

	/** 停止流式：消费剩余音频 → finalize → 返回最终文本并释放模型。 */
	async stop(): Promise<{ text: string; seconds: number }> {
		const stream = this.stream;
		if (!stream || !this.model || !this.session) throw new Error("not streaming");
		this.stopping = true;
		this.stream = undefined;
		await this.feedPromise.catch(() => undefined);
		// 最后再消费一次 live 文件（worker 已停止写入）；用局部引用避免竞态。
		// 必须允许 stopping 状态：stop() 先把 stopping 置 true 用于停掉 feed 循环，
		// 但这次冲刷仍要读文件，否则 worker 冲刷的尾部音频会被丢在文件里。
		await this.pump(stream, true).catch(() => undefined);
		let finalText = this.committed;
		try {
			await stream.finalize();
			const snap = stream.text;
			finalText = snap.committed || snap.full || this.committed;
		} catch (error) {
			console.error("[transcribe] live finalize error:", error);
		}
		const seconds = this.lastFed / 16_000;
		try {
			stream.reset();
		} catch {
			// ignore
		}
		// dispose 失败不能吞掉已定稿的文本（IPC 已在返回前抛错会丢失转写结果）。
		try {
			this.session.dispose();
		} catch {
			// ignore
		}
		try {
			this.model.dispose();
		} catch {
			// ignore
		}
		this.session = undefined;
		this.model = undefined;
		this.committed = finalText;
		this.tentative = "";
		if (this.livePath) {
			await rm(this.livePath, { force: true }).catch(() => undefined);
			this.livePath = undefined;
		}
		return { text: finalText, seconds: +seconds.toFixed(1) };
	}

	/** 录音被取消（不 finalize）时释放资源。 */
	async cancel(): Promise<void> {
		this.stopping = true;
		this.stream = undefined;
		await this.feedPromise.catch(() => undefined);
		try {
			this.session?.dispose();
		} catch {
			// ignore
		}
		try {
			this.model?.dispose();
		} catch {
			// ignore
		}
		this.session = undefined;
		this.model = undefined;
		this.committed = "";
		this.tentative = "";
		if (this.livePath) {
			await rm(this.livePath, { force: true }).catch(() => undefined);
			this.livePath = undefined;
		}
	}

	/** 应用退出清理：中断活动会话、释放模型与临时文件。 */
	async dispose(): Promise<void> {
		await this.cancel().catch(() => undefined);
	}
}

let singleton: LiveStreamController | undefined;

/** 主进程级流式控制器单例。 */
export function getLiveStreamController(): LiveStreamController {
	singleton ??= new LiveStreamController();
	return singleton;
}
