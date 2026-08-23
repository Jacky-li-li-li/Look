// ============================================================
// TranscribeExtension — transcribe_file 工具
//
// 让 Agent 能转写本地音频/视频文件（会议录音、语音消息等）。
// 核心链路：settings → 模型存在性检查 → ffmpeg 解码 → 本地推理。
//
// 权限模型：transcribe_file 读取本地媒体文件并执行 ffmpeg，
// 声明为需要用户确认的工具（走 Look 声明式权限拦截）。
//
// 注入点：CompositionBuilder.buildExtensionFactories()。
// ============================================================

import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { getLookDir } from "@look/shared";
import { Type } from "typebox";
import { decodeFileAudio } from "../transcribe/file-audio.js";
import { getBuiltinTranscribeModel } from "../transcribe/model-catalog.js";
import { findDownloadedModel } from "../transcribe/model-downloader.js";
import { readTranscribeSettings } from "../transcribe/settings.js";
import type { TranscriptionService } from "../transcribe/transcription-service.js";
import { declareApprovalRequiredTool } from "./tool-permission-registry.js";

const CONTEXT_LINE_LENGTH = 1_000;

export type TranscribeExtensionOptions = {
	service: TranscriptionService;
	/** 项目共享区 transcripts 目录（共享面板可见、路径稳定可点）；
	 *  无项目时为 null，回退系统临时目录（不保证持久）。 */
	sharedDir: string | null;
};

/** 包装长行，让 Look 的行级截断能保留有用文本。 */
function wrapLongLines(text: string): string {
	const output: string[] = [];
	for (const originalLine of text.split("\n")) {
		let line = originalLine;
		while (line.length > CONTEXT_LINE_LENGTH) {
			let split = line.lastIndexOf(" ", CONTEXT_LINE_LENGTH);
			if (split <= 0) split = CONTEXT_LINE_LENGTH;
			output.push(line.slice(0, split));
			line = line.slice(split).trimStart();
		}
		output.push(line);
	}
	return output.join("\n");
}

/** 把源文件名转成安全的转录稿文件名前缀（去扩展名；空白/路径分隔等
 *  非法字符下划线化，保留中文等 Unicode 字母数字）。 */
export function transcriptFileBase(inputPath: string): string {
	const base = basename(inputPath)
		.replace(/\.[^.]+$/, "")
		.replace(/[^\p{L}\p{N}._-]+/gu, "_")
		.trim();
	return base || "audio";
}

/**
 * 保存完整转录稿。
 * 优先写入项目共享区（`shared/<projectId>/transcripts/`）：目录位于 LOOK_HOME 下，
 * 不会被系统临时目录清理，且共享面板可见、可点击预览（与 computer-use 截图落盘同模式）。
 * 无项目时回退系统临时目录（当前行为，不保证持久）。
 */
export async function saveFullTranscript(text: string, sharedDir: string | null, inputPath: string): Promise<string> {
	const content = `${text}\n`;
	if (sharedDir) {
		await mkdir(sharedDir, { recursive: true });
		const path = join(sharedDir, `${transcriptFileBase(inputPath)}.transcript-${Date.now()}.txt`);
		await writeFile(path, content, "utf8");
		return path;
	}
	const directory = await mkdtemp(join(tmpdir(), "look-transcribe-"));
	const path = join(directory, "transcript.txt");
	await writeFile(path, content, "utf8");
	return path;
}

function normalizeToolPath(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

export function createTranscribeExtensionFactory(options: TranscribeExtensionOptions): ExtensionFactory {
	declareApprovalRequiredTool("transcribe_file");
	const { service, sharedDir } = options;

	return (api) => {
		api.registerTool({
			name: "transcribe_file",
			label: "Transcribe File",
			description:
				"Transcribe speech from a local audio or video file using the local transcription model. Requires the ffmpeg executable on PATH (or TRANSCRIBE_FFMPEG_PATH). Output is truncated; the full transcript is always saved to the project shared area (a temporary file when no project is open) and the saved path is included in the result.",
			promptSnippet: "Transcribe speech from local audio or video files with a local model",
			promptGuidelines: [
				"Use transcribe_file when speech in a local audio or video file needs to be read, analyzed, or transcribed — but always ask the user first whether they want the file transcribed, and only call this tool after explicit confirmation.",
				"Audio/video attachments appear as [Media attachment: … stored at <path>] blocks; never read media files as text.",
				"If transcribe_file reports that the model is missing, ask the user to download it first (Settings → Voice Assistant).",
				"If transcribe_file reports that FFmpeg is unavailable, explain the installation guidance and ask the user before running a system package-manager command.",
				"When the tool result includes a [Transcript saved to: <path>] note, cite that exact path in your reply. Never claim the transcript was saved to a file (or to the shared area) unless the tool result reports a path — for very short transcripts no save may occur.",
			],
			parameters: Type.Object({
				path: Type.String({
					description: "Local media file path, absolute or relative to the current working directory",
				}),
			}),

			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const input = normalizeToolPath(params.path.trim());
				if (!input) throw new Error("A media file path is required");
				const inputPath = resolve(ctx.cwd, input);
				const inputStat = await stat(inputPath).catch((error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") throw new Error(`Media file not found: ${inputPath}`);
					throw error;
				});
				if (!inputStat.isFile()) throw new Error(`Media path is not a regular file: ${inputPath}`);
				signal?.throwIfAborted();

				const settings = readTranscribeSettings();
				const model = getBuiltinTranscribeModel(settings.modelId);
				if (!model) {
					throw new Error(
						`Configured transcription model "${settings.modelId}" is unknown. Available models: Qwen3-ASR-0.6B, nemotron-3.5-asr-streaming-0.6b.`,
					);
				}
				const modelPath = await findDownloadedModel(getLookDir(), model);
				if (!modelPath) {
					throw new Error(
						`The transcription model ${model.id} is not downloaded yet. Ask the user to download it (${formatSize(model.size)}) before retrying transcribe_file.`,
					);
				}

				onUpdate?.({
					content: [{ type: "text", text: `Decoding ${basename(inputPath)} with FFmpeg…` }],
					details: { inputPath, modelId: model.id, seconds: 0 },
				});
				const audio = await decodeFileAudio(inputPath, signal);

				onUpdate?.({
					content: [
						{
							type: "text",
							text: `Queued ${audio.seconds.toFixed(1)}s of audio for local transcription…`,
						},
					],
					details: { inputPath, modelId: model.id, seconds: +audio.seconds.toFixed(1) },
				});
				const transcript = await service.transcribeFile(modelPath, audio.pcm, {
					signal,
					language: settings.transcriptionLanguage,
					chineseOutput: settings.chineseOutput,
				});

				if (!transcript) {
					return {
						content: [
							{
								type: "text",
								text: `No speech detected in ${audio.seconds.toFixed(1)}s of audio from ${inputPath}`,
							},
						],
						details: { inputPath, modelId: model.id, seconds: +audio.seconds.toFixed(1) },
					};
				}

				// 完整转录稿落盘到共享区（无项目回退 tmpdir），结果中带上真实路径：
				// 只有工具回传的路径才可信，避免 agent 凭空声称"已保存"而引用不存在的文件。
				// 保存失败不阻断返回（转录文本仍内联给出），只是不声称有落盘文件。
				const savedPath = await saveFullTranscript(transcript, sharedDir, inputPath).catch((error: unknown) => {
					console.error("[transcribe] save full transcript failed:", error);
					return null;
				});

				const contextTranscript =
					Buffer.byteLength(transcript, "utf8") > DEFAULT_MAX_BYTES ? wrapLongLines(transcript) : transcript;
				const truncation: TruncationResult = truncateHead(contextTranscript, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});
				let resultText = truncation.content;
				if (truncation.truncated) {
					resultText += `\n\n[Transcript truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})`;
					resultText += savedPath ? `. Full transcript saved to: ${savedPath}]` : ".]";
				} else if (savedPath) {
					resultText += `\n\n[Transcript saved to: ${savedPath}]`;
				}

				return {
					content: [{ type: "text", text: resultText }],
					details: { inputPath, modelId: model.id, seconds: +audio.seconds.toFixed(1) },
				};
			},
		});
	};
}
