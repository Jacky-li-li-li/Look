// ============================================================
// Mic worker — 独立进程录音（与主进程事件循环隔离）
//
// PvRecorder 的 stop() 在部分 macOS 设备上会同步阻塞，若在主进程
// 调用会卡死整个 Electron。因此录音放到独立进程：PCM 与 RMS 写
// 临时文件，主进程轮询/读取。收到 stdin "stop" 或 SIGTERM 时写
// 完整 PCM 文件后直接退出（不调 native stop，由 OS 回收设备）。
//
// 用法: node mic-worker.js <rms-path> <pcm-path>
// ============================================================

import { appendFileSync, writeFileSync } from "node:fs";
import { PvRecorder } from "@picovoice/pvrecorder-node";

const FRAME = 512;
const SAMPLE_RATE = 16_000;

const args = process.argv.slice(2);
const rmsPath = args[0];
const pcmPath = args[1];
const liveIdx = args.indexOf("--live");
const livePath = liveIdx >= 0 ? args[liveIdx + 1] : undefined;
if (!rmsPath || !pcmPath) {
	console.error("usage: mic-worker <rms-path> <pcm-path> [--live <live-path>]");
	process.exit(2);
}

// growable Float32 缓冲
let allPcm = new Float32Array(SAMPLE_RATE * 60);
let pcmLen = 0;
let lastAppended = 0;

let stopping = false;
const rec = new PvRecorder(FRAME, -1);
rec.start();
console.log("MIC_READY", rec.sampleRate);

function pushFrame(frame: Int16Array): void {
	if (pcmLen + frame.length > allPcm.length) {
		const next = new Float32Array(allPcm.length * 2);
		next.set(allPcm);
		allPcm = next;
	}
	for (let i = 0; i < frame.length; i += 1) allPcm[pcmLen++] = frame[i] / 32768;
}

/** 流式模式：把未追加的音频写入 live 文件，供主进程 feed。
 *  force=true 时忽略 ≥1s 阈值 —— 停止前必须冲刷尾部，否则流式转写
 *  会丢掉最后 ~1s 的语音（主进程停止路径只消费 live 文件，不读完整 PCM）。 */
function appendLive(force = false): void {
	if (!livePath || stopping) return;
	if (!force && pcmLen - lastAppended < SAMPLE_RATE) return;
	try {
		const chunk = allPcm.subarray(lastAppended, pcmLen);
		appendFileSync(livePath, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		lastAppended = pcmLen;
	} catch {
		// live 文件瞬时不可写：下个周期重试
	}
}
setInterval(() => appendLive(), 400);

function frameRms(frame: Int16Array): number {
	let sum = 0;
	for (let i = 0; i < frame.length; i += 1) {
		const v = frame[i] / 32768;
		sum += v * v;
	}
	return Math.sqrt(sum / frame.length);
}

async function readLoop(): Promise<void> {
	while (!stopping && rec.isRecording) {
		const frame = await rec.read();
		if (stopping) break;
		pushFrame(frame);
		try {
			writeFileSync(rmsPath, frameRms(frame).toFixed(4));
		} catch {
			// rms 文件瞬时不可写：忽略
		}
	}
}

function finish(): void {
	if (stopping) return;
	// 必须在置 stopping=true 之前冲刷（appendLive 拒绝在 stopping 状态写入）。
	appendLive(true);
	stopping = true;
	// 不调 rec.stop()/release()：部分设备上同步阻塞。直接写文件退出。
	try {
		const pcm = new Float32Array(pcmLen);
		pcm.set(allPcm.subarray(0, pcmLen));
		writeFileSync(pcmPath, Buffer.from(pcm.buffer));
	} catch (error) {
		console.error("[mic-worker] finish failed:", error);
		process.exit(1);
	}
	try {
		writeFileSync(rmsPath, "0");
	} catch {
		// ignore
	}
	console.log("MIC_DONE", pcmLen / SAMPLE_RATE, "s");
	process.exit(0);
}

process.on("SIGTERM", finish);
process.stdin.on("data", (data: Buffer) => {
	if (String(data).includes("stop")) finish();
});
process.stdin.resume();

void readLoop().catch((error: unknown) => {
	console.error("[mic-worker] read loop failed:", error);
	process.exit(1);
});
