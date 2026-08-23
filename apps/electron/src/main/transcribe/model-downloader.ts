// ============================================================
// Transcribe — 模型下载器（方案 A：双源回退）
//
// 默认从 Hugging Face 官方源下载；连接失败 / 超时 / HTTP 错误时
// 自动切换到镜像源（hf-mirror.com）。模型文件存放在
// `$LOOK_HOME/models/<modelId>/<filename>`，带 sha256 完整性校验：
//
//   下载 → 写入 .incomplete 临时文件（支持断点续传，Range 续传）
//   → 校验 size + sha256 → 原子 rename 为最终文件
//
// 参考实现：pi-transcribe testlab（已验证双源回退与校验链路）。
// ============================================================

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TranscribeModelInfo } from "./model-catalog.js";

/** 官方源与镜像源。顺序即回退顺序。 */
const MODEL_SOURCES: readonly string[] = [
	process.env.TRANSCRIBE_HF_ENDPOINT ?? "https://huggingface.co",
	"https://hf-mirror.com",
];

const RETRY_DELAY_MS = 500;
const DOWNLOAD_TIMEOUT_MS = 60_000; // 单次连接超时（响应头超时，非总时长）

/** 下载完成但 size/sha256 校验失败 —— 已落盘内容不可信，断点必须作废。 */
class VerificationError extends Error {}

/** 服务端不支持断点续传（Range 请求得到 416 或被忽略返回 200 全量）—— 需整体重下。 */
class ResumeNotSupportedError extends Error {}

export type DownloadProgress = { downloaded: number; total: number };

export type DownloadOptions = {
	signal?: AbortSignal;
	onProgress?: (progress: DownloadProgress) => void;
};

export function transcribeModelsDir(lookDir: string): string {
	return join(lookDir, "models");
}

export function transcribeModelDir(lookDir: string, model: TranscribeModelInfo): string {
	return join(transcribeModelsDir(lookDir), model.id);
}

export function transcribeModelPath(lookDir: string, model: TranscribeModelInfo): string {
	return join(transcribeModelDir(lookDir, model), model.filename);
}

export async function findDownloadedModel(lookDir: string, model: TranscribeModelInfo): Promise<string | undefined> {
	const path = transcribeModelPath(lookDir, model);
	try {
		const info = await stat(path);
		return info.size === model.size ? path : undefined;
	} catch {
		return undefined;
	}
}

function sourceUrl(source: string, model: TranscribeModelInfo): string {
	return `${source}/${model.repository}/resolve/${model.revision}/${model.filename}`;
}

/**
 * 双源回退下载。返回最终模型文件路径；所有校验通过后才返回。
 * 已存在的完整文件直接复用；`.incomplete` 残留自动断点续传（含跨源：
 * 官方源中途断流后镜像源从实际落盘位置继续）。
 */
export async function downloadModel(
	lookDir: string,
	model: TranscribeModelInfo,
	options: DownloadOptions = {},
): Promise<string> {
	const { signal, onProgress } = options;
	signal?.throwIfAborted();

	const dir = transcribeModelDir(lookDir, model);
	const finalPath = transcribeModelPath(lookDir, model);
	const existing = await findDownloadedModel(lookDir, model);
	if (existing) {
		onProgress?.({ downloaded: model.size, total: model.size });
		return existing;
	}

	await mkdir(dir, { recursive: true });
	// 固定文件名（不带 pid/uuid）：随机名会让上次中断留下的部分永远无法续传。
	const incompletePath = join(dir, `.${model.filename}.incomplete`);

	// 断点基线：已落盘部分喂进 digest 模板；每次源尝试 copy() 一份独立摘要，
	// 避免上一个源的半程数据污染下一个源的 sha256（重试必须从头算总账）。
	let resumeOffset = 0;
	let baseDigest = createHash("sha256");
	const existingSize = await stat(incompletePath)
		.then((info) => info.size)
		.catch(() => 0);
	if (existingSize >= model.size) {
		// 超过预期大小（上次下载异常）：作废重来。
		await rm(incompletePath, { force: true });
	} else if (existingSize > 0) {
		resumeOffset = existingSize;
		console.warn(`[transcribe] resuming ${model.id} from ${resumeOffset} bytes`);
		await feedDigestFrom(incompletePath, 0, baseDigest);
	}

	let lastError: unknown;
	let sourceIndex = 0;
	while (sourceIndex < MODEL_SOURCES.length) {
		const source = MODEL_SOURCES[sourceIndex];
		signal?.throwIfAborted();
		try {
			const digest = baseDigest.copy();
			await downloadFromSource(source, model, incompletePath, resumeOffset, digest, signal, onProgress);
			// 校验
			const finalStat = await stat(incompletePath);
			if (finalStat.size !== model.size) {
				throw new VerificationError(`size mismatch: expected ${model.size}, got ${finalStat.size}`);
			}
			if (digest.digest("hex") !== model.sha256) {
				throw new VerificationError("sha256 verification failed");
			}
			await rename(incompletePath, finalPath);
			onProgress?.({ downloaded: model.size, total: model.size });
			return finalPath;
		} catch (error) {
			if (signal?.aborted) throw error;
			lastError = error;
			console.warn(
				`[transcribe] download from ${source} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (error instanceof ResumeNotSupportedError && resumeOffset > 0) {
				// 服务端不支持 Range：作废断点，同源从头重下（不前进到下一源）。
				await rm(incompletePath, { force: true }).catch(() => undefined);
				resumeOffset = 0;
				baseDigest = createHash("sha256");
				continue;
			}
			if (error instanceof VerificationError) {
				// 内容损坏：断点不可信，删除后换源整体重下。
				await rm(incompletePath, { force: true }).catch(() => undefined);
				resumeOffset = 0;
				baseDigest = createHash("sha256");
			} else {
				// 网络类失败：保留已落盘部分，下一源（或下次调用）从实际落盘位置续传。
				const newSize = await stat(incompletePath)
					.then((info) => info.size)
					.catch(() => 0);
				if (newSize > resumeOffset) {
					await feedDigestFrom(incompletePath, resumeOffset, baseDigest);
					resumeOffset = newSize;
				}
			}
			sourceIndex += 1;
			await sleep(RETRY_DELAY_MS);
		}
	}
	// 到这里只剩网络类失败留下的断点（故意保留供下次续传）。
	throw new Error(
		`模型下载失败（已尝试 ${MODEL_SOURCES.length} 个源）：${lastError instanceof Error ? lastError.message : String(lastError)}`,
	);
}

/** 把文件 [start, EOF) 的字节喂进 digest（构建/推进断点基线）。 */
function feedDigestFrom(path: string, start: number, digest: ReturnType<typeof createHash>): Promise<void> {
	return new Promise((resolve, reject) => {
		const rs = createReadStream(path, { start });
		rs.on("data", (chunk: Buffer) => digest.update(chunk));
		rs.on("end", () => resolve());
		rs.on("error", reject);
	});
}

async function downloadFromSource(
	source: string,
	model: TranscribeModelInfo,
	targetPath: string,
	resumeOffset: number,
	digest: ReturnType<typeof createHash>,
	signal: AbortSignal | undefined,
	onProgress: DownloadOptions["onProgress"],
): Promise<void> {
	const url = sourceUrl(source, model);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("连接超时")), DOWNLOAD_TIMEOUT_MS);
	const onAbort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });

	let resp: Response;
	try {
		resp = await fetch(url, {
			signal: controller.signal,
			redirect: "follow",
			headers: resumeOffset > 0 ? { Range: `bytes=${resumeOffset}-` } : undefined,
		});
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
	}

	if (
		resp.status === 416 ||
		(resumeOffset > 0 && resp.status === 200) // 正常 Range 续传应返回 206；200 表示服务端忽略 Range 回全量
	) {
		throw new ResumeNotSupportedError(`HTTP ${resp.status}: cannot resume from byte ${resumeOffset}`);
	}
	if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
	if (!resp.body) throw new Error("empty response body");

	const total = resumeOffset + (Number(resp.headers.get("content-length")) || model.size - resumeOffset);
	const ws = createWriteStream(targetPath, { flags: resumeOffset > 0 ? "a" : "w" });
	let downloaded = resumeOffset;
	let lastReport = 0;
	const reader = resp.body.getReader();

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			digest.update(value);
			// 写背压：磁盘慢时暂停读取，避免 850MB 模型全量堆在写缓冲里。
			if (!ws.write(value)) {
				await new Promise<void>((resolve, reject) => {
					ws.once("drain", resolve);
					ws.once("error", reject);
				});
			}
			downloaded += value.length;
			const now = Date.now();
			if (now - lastReport >= 100 || downloaded >= total) {
				lastReport = now;
				onProgress?.({ downloaded, total });
			}
		}
		await new Promise<void>((resolve, reject) =>
			ws.end((error?: Error | null) => (error ? reject(error) : resolve())),
		);
		onProgress?.({ downloaded, total });
	} catch (error) {
		await new Promise<void>((resolve) => ws.end(resolve));
		throw error;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
