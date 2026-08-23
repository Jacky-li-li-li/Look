// ============================================================
// RecordingController — 麦克风录音控制（worker 进程隔离）
//
// start(): spawn mic-worker（PvRecorder 16k mono 录音）
// stop():  停止 worker → 读取完整 PCM
// rms:     实时电平（供 UI 轮询）
//
// 与 TranscriptionService 解耦：转写由调用方（IPC router）执行。
// ============================================================

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";

const MIC_DIR = join(tmpdir(), "look-transcribe-mic");

export class RecordingController {
	private worker: ChildProcess | undefined;
	private pcmPath: string | undefined;
	private rmsPath: string | undefined;

	get recording(): boolean {
		return this.worker !== undefined;
	}

	/** 最近一帧 RMS（0..1），未录音时为 0。 */
	async level(): Promise<number> {
		if (!this.rmsPath) return 0;
		try {
			const value = Number((await readFile(this.rmsPath, "utf8")).trim());
			return Number.isFinite(value) ? value : 0;
		} catch {
			return 0;
		}
	}

	/** 启动录音。livePath 存在时 worker 增量输出音频（供流式转写 feed）。 */
	start(livePath?: string): void {
		if (this.worker) throw new Error("already recording");
		mkdirSync(MIC_DIR, { recursive: true });
		const rmsPath = join(MIC_DIR, "mic.rms");
		const pcmPath = join(MIC_DIR, `mic-${Date.now()}.pcm`);
		writeFileSync(rmsPath, "0");
		const workerArgs = [join(import.meta.dirname, "mic-worker.js"), rmsPath, pcmPath];
		if (livePath) workerArgs.push("--live", livePath);
		const worker = spawn(process.execPath, workerArgs, {
			stdio: ["pipe", "ignore", "inherit"],
			// 打包后 process.execPath 是 Electron 主程序：不带此变量会拉起第二个
			// 完整 app 实例（脚本参数被当作 argv 传给已打包的 app，worker 根本不执行），
			// 必须以纯 Node 模式运行 worker。
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		});
		this.worker = worker;
		this.pcmPath = pcmPath;
		this.rmsPath = rmsPath;
		worker.on("exit", (code) => {
			if (this.worker === worker) {
				this.worker = undefined;
			}
			if (code && code !== 0) console.error(`[transcribe] mic worker exited with ${code}`);
		});
	}

	async stop(): Promise<{ pcm: Float32Array; seconds: number }> {
		const worker = this.worker;
		const pcmPath = this.pcmPath;
		if (!worker || !pcmPath) throw new Error("not recording");
		this.worker = undefined;
		this.pcmPath = undefined;
		const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
		worker.stdin?.write("stop\n");
		const killTimer = setTimeout(() => worker.kill("SIGKILL"), 5000);
		await exited;
		clearTimeout(killTimer);
		const buf = await readFile(pcmPath);
		const pcm = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
		await rm(pcmPath, { force: true }).catch(() => undefined);
		return { pcm, seconds: pcm.length / CAPTURE_SAMPLE_RATE };
	}

	/** 立即终止录音（应用退出清理）：杀掉 worker，不做收尾写入。
	 *  退出路径不需要 PCM 结果，直接 SIGKILL 避免阻塞在 worker 收尾上。 */
	dispose(): void {
		const worker = this.worker;
		this.worker = undefined;
		this.pcmPath = undefined;
		this.rmsPath = undefined;
		if (worker) {
			try {
				worker.kill("SIGKILL");
			} catch {
				// ignore
			}
		}
	}
}

let singleton: RecordingController | undefined;

export function getRecordingController(): RecordingController {
	singleton ??= new RecordingController();
	return singleton;
}

export { CAPTURE_SAMPLE_RATE };
