// ============================================================
// Transcribe router — 语音助手（本地转写）配置 IPC
// ============================================================

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLookDir } from "@look/shared";
import type { TranscribeSettingsPatch } from "@look/shared/contracts/ipc";
import { convertChineseOutput } from "../../transcribe/chinese.js";
import { getLiveStreamController } from "../../transcribe/live-stream.js";
import { getTranscribeManager } from "../../transcribe/manager.js";
import { getBuiltinTranscribeModel } from "../../transcribe/model-catalog.js";
import { findDownloadedModel } from "../../transcribe/model-downloader.js";
import { getRecordingController } from "../../transcribe/recording.js";
import { languagesSupportLanguage } from "../../transcribe/transcription.js";
import { getTranscriptionService } from "../../transcribe/transcription-service.js";
import { guardObject, guardString } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

/** record-start 正在初始化（worker 启动/流式模型加载中）。
 *  record-stop 若在此时到达（如切换会话触发卸载清理），先等它落定再停止，
 *  避免 stop 先于 start 完成而留下孤儿 worker / 孤儿流式会话。 */
let pendingStart: Promise<unknown> | undefined;

export const transcribeRouter: IpcRouter = (_ctx, register) => {
	register("transcribe:get-state", async () => {
		const state = await getTranscribeManager().getState();
		return { success: true, state };
	});

	register("transcribe:set-settings", async (data) => {
		const patch = guardObject(data.patch, "transcribe settings patch") as unknown as TranscribeSettingsPatch;
		if (patch.modelId !== undefined) guardString(patch.modelId, "modelId");
		if (patch.transcriptionLanguage !== undefined) {
			guardString(patch.transcriptionLanguage, "transcriptionLanguage");
		}
		const settings = await getTranscribeManager().setSettings(patch);
		return { success: true, settings };
	});

	register("transcribe:download-model", async (data) => {
		const modelId = guardString(data.modelId, "modelId");
		// 下载在后台执行；立即返回，渲染端轮询 get-state 获取进度。
		void getTranscribeManager()
			.download(modelId)
			.catch((error: unknown) => {
				console.warn(`[transcribe] download failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		return { success: true, ok: true };
	});

	register("transcribe:delete-model", async (data) => {
		const modelId = guardString(data.modelId, "modelId");
		await getTranscribeManager().deleteModel(modelId);
		return { success: true, ok: true };
	});

	register("transcribe:record-start", async () => {
		const run = async (): Promise<{ success: true; ok: boolean }> => {
			// 模型必须已下载才能开始录音（转写在停止时执行）。
			const manager = getTranscribeManager();
			const { settings, models } = await manager.getState();
			const model = models.find((m) => m.id === settings.modelId);
			if (!model?.cached) {
				throw new Error(
					"语音转写模型尚未下载。请先在 设置 → 语音助手 下载模型（Qwen3-ASR-0.6B 或 Nemotron Streaming），再使用语音输入。",
				);
			}
			const info = getBuiltinTranscribeModel(settings.modelId);
			if (!info) throw new Error(`未知转写模型: ${settings.modelId}`);
			// 语言预检（流式/非流式统一在开始录音前校验，而不是录完才报错白录一次）。
			const language = settings.transcriptionLanguage;
			if (language !== "auto" && !languagesSupportLanguage(info.languages, language)) {
				throw new Error(`当前转写模型不支持语言 ${language}，请到 设置 → 语音助手 切换为 auto 或选择支持的语言。`);
			}
			if (info.streaming) {
				// 流式模型：worker 增量输出 + 实时 feed（边说边出字）。
				const livePath = join(tmpdir(), "look-transcribe-mic", `live-${Date.now()}.f32`);
				getRecordingController().start(livePath);
				try {
					const modelPath = await findDownloadedModel(getLookDir(), info);
					if (!modelPath) throw new Error("语音转写模型文件缺失，请到 设置 → 语音助手 重新下载。");
					await getLiveStreamController().start(modelPath, livePath, language);
				} catch (error) {
					// 回滚：停止录音 worker 并清理 live 临时文件。否则麦克风进程在
					// IPC 已失败的情况下持续录制，且后续 record-start 会因
					// "already recording" 死锁到应用重启。
					await getRecordingController()
						.stop()
						.catch(() => undefined);
					await rm(livePath, { force: true }).catch(() => undefined);
					throw error;
				}
			} else {
				getRecordingController().start();
			}
			return { success: true, ok: true };
		};
		const promise = run();
		// 追踪在途启动：record-stop 在卸载清理场景下可能先于本 promise 落定到达，
		// 需要等它完成后再停止，否则 stop 会看到"未在录音"而 start 之后才真正启动。
		pendingStart = promise.finally(() => {
			if (pendingStart === promise) pendingStart = undefined;
		});
		return promise;
	});

	register("transcribe:record-stop", async () => {
		if (pendingStart) {
			// record-start 仍在初始化（worker 启动/流式模型加载）：等它落定，
			// 再走正常停止路径 —— 直接停会与 in-flight 的 start 竞态。
			await pendingStart.catch(() => undefined);
		}
		const live = getLiveStreamController();
		if (live.active) {
			// 流式路径：先停录音 worker（停止写入），再 finalize。
			const recording = getRecordingController();
			if (recording.recording) {
				await recording.stop().catch(() => undefined);
			}
			const settings = (await getTranscribeManager().getState()).settings;
			const { text, seconds } = await live.stop();
			// 与一次性/文件转写路径保持一致：应用中文简繁输出转换。
			// 流式模型不返回检测语言，OpenCC 对非中文文本是恒等变换，可直接套用。
			const converted = await convertChineseOutput(text, settings.chineseOutput).catch(() => text);
			return { success: true, text: converted, seconds };
		}
		const recording = getRecordingController();
		const { pcm, seconds } = await recording.stop();
		// 静音守卫：近零 RMS 音频会让 transcribe.cpp 报 OUTPUT_TRUNCATED，
		// 直接按"未检测到语音"处理。
		let sum = 0;
		for (let i = 0; i < pcm.length; i += 1) sum += pcm[i] * pcm[i];
		const rms = Math.sqrt(sum / Math.max(1, pcm.length));
		if (seconds < 0.4 || rms < 0.004) {
			return { success: true, text: "", seconds: +seconds.toFixed(1) };
		}
		const settings = (await getTranscribeManager().getState()).settings;
		const model = getBuiltinTranscribeModel(settings.modelId);
		if (!model) throw new Error(`未知转写模型: ${settings.modelId}`);
		const modelPath = await findDownloadedModel(getLookDir(), model);
		if (!modelPath) throw new Error("语音转写模型文件缺失，请到 设置 → 语音助手 重新下载。");
		const text = await getTranscriptionService().transcribeFile(modelPath, pcm, {
			language: settings.transcriptionLanguage,
			chineseOutput: settings.chineseOutput,
		});
		return { success: true, text, seconds: +seconds.toFixed(1) };
	});

	register("transcribe:record-state", async () => {
		const recording = getRecordingController();
		const live = getLiveStreamController();
		return {
			success: true,
			recording: recording.recording,
			rms: await recording.level(),
			streaming: live.active,
			committed: live.committed,
			tentative: live.tentative,
		};
	});
};
