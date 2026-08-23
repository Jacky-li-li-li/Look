// ============================================================
// Transcribe — FFmpeg 文件解码
//
// 从 pi-transcribe 移植（MIT）：ffmpeg 解码首个音轨 → 16k mono
// f32 PCM（transcribe.cpp 输入格式）。128 MiB 解码上限（约 35 分钟），
// ffmpeg 缺失时给出按平台的安装指引。
// ============================================================

import { spawn } from "node:child_process";

export const FILE_SAMPLE_RATE = 16_000;

const BYTES_PER_SAMPLE = Float32Array.BYTES_PER_ELEMENT;
const MAX_DECODED_BYTES = 128 * 1024 * 1024;
const MAX_STDERR_CHARS = 8 * 1024;

function ffmpegExecutable(): string {
	return process.env.TRANSCRIBE_FFMPEG_PATH?.trim() || "ffmpeg";
}

function installHint(): string {
	switch (process.platform) {
		case "darwin":
			return "On macOS with Homebrew: brew install ffmpeg";
		case "win32":
			return "On Windows: winget install Gyan.FFmpeg";
		default:
			return "On Debian/Ubuntu: sudo apt install ffmpeg (use your distribution's package manager elsewhere)";
	}
}

function missingFfmpegError(): Error {
	const configured = process.env.TRANSCRIBE_FFMPEG_PATH?.trim();
	const locationHelp = configured
		? `The configured TRANSCRIBE_FFMPEG_PATH (${configured}) could not be found. Correct it or unset it to use PATH.`
		: "The ffmpeg executable was not found on PATH.";
	return new Error(
		[
			"File transcription requires FFmpeg.",
			locationHelp,
			installHint(),
			"Explain this requirement to the user and ask permission before installing system software, then retry transcribe_file.",
		].join(" "),
	);
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("File audio decoding was cancelled");
}

export type DecodedFileAudio = {
	pcm: Float32Array;
	seconds: number;
};

/** 解码本地媒体文件首个音轨为 transcribe.cpp PCM。 */
export async function decodeFileAudio(path: string, signal?: AbortSignal): Promise<DecodedFileAudio> {
	signal?.throwIfAborted();
	const executable = ffmpegExecutable();
	const child = spawn(
		executable,
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			path,
			"-f",
			"f32le",
			"-ac",
			"1",
			"-ar",
			String(FILE_SAMPLE_RATE),
			"pipe:1",
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);

	const chunks: Buffer[] = [];
	let bytes = 0;
	let stderr = "";
	let stderrOverflow = false;
	let sizeOverflow = false;
	let rejectAbort: (error: Error) => void = () => undefined;

	const abortPromise = new Promise<never>((_, reject) => {
		rejectAbort = reject;
	});
	const onAbort = () => {
		child.kill("SIGKILL");
		rejectAbort(abortReason(signal!));
	};
	if (signal) {
		if (signal.aborted) {
			child.kill("SIGKILL");
			throw abortReason(signal);
		}
		signal.addEventListener("abort", onAbort, { once: true });
	}

	child.stdout.on("data", (chunk: Buffer) => {
		bytes += chunk.length;
		if (bytes > MAX_DECODED_BYTES) {
			sizeOverflow = true;
			child.kill("SIGKILL");
			return;
		}
		chunks.push(chunk);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		if (stderrOverflow) return;
		stderr += chunk.toString("utf8");
		if (stderr.length > MAX_STDERR_CHARS) {
			stderrOverflow = true;
			stderr = stderr.slice(0, MAX_STDERR_CHARS);
		}
	});

	const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.on("close", (code, childSignal) => resolve({ code, signal: childSignal }));
		child.on("error", (_error) => {
			// ENOENT → ffmpeg 不在 PATH
			rejectAbort(missingFfmpegError());
			resolve({ code: null, signal: null });
		});
	});

	try {
		const { code } = await Promise.race([exitPromise, abortPromise]);
		signal?.removeEventListener("abort", onAbort);
		if (sizeOverflow) {
			throw new Error(
				`Decoded audio exceeds the ${Math.round(MAX_DECODED_BYTES / 1024 / 1024)} MiB limit (~35 minutes); use a shorter file`,
			);
		}
		if (code !== 0) {
			const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : "";
			throw new Error(`FFmpeg exited with code ${code}${detail}`);
		}
		const pcm = Buffer.concat(chunks);
		if (pcm.byteLength === 0) {
			throw new Error("FFmpeg decoded no audio samples; the file may not contain an audio stream");
		}
		if (pcm.byteLength % BYTES_PER_SAMPLE !== 0) {
			throw new Error("Decoded audio has an unexpected byte length");
		}
		const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / BYTES_PER_SAMPLE);
		return { pcm: samples, seconds: samples.length / FILE_SAMPLE_RATE };
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}
