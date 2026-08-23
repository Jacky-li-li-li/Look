// ============================================================
// Transcribe — 主进程管理器（模块级单例）
//
// 统一管理模型下载状态、设置读写，供 IPC router 与未来 UI 使用。
// 与 TranscriptionService（转写执行）解耦：manager 只管"模型资产"。
// 下载进度存内存，渲染端轮询 getState()。
// ============================================================

import { rm } from "node:fs/promises";
import { getLookDir } from "@look/shared";
import type { TranscribeModelState } from "@look/shared/contracts/ipc";
import { BUILTIN_TRANSCRIBE_MODELS, getBuiltinTranscribeModel, type TranscribeModelInfo } from "./model-catalog.js";
import { downloadModel, findDownloadedModel, transcribeModelDir } from "./model-downloader.js";
import { readTranscribeSettings, type TranscribeSettings, writeTranscribeSettings } from "./settings.js";

type DownloadState = {
	done: number;
	total: number;
	status: "downloading" | "done" | "error";
	error?: string;
};

const CHINESE_OUTPUTS = ["simplified", "traditional-taiwan", "traditional-hong-kong"] as const;

export class TranscribeManager {
	private readonly downloads = new Map<string, DownloadState>();

	async getState(): Promise<{ settings: TranscribeSettings; models: TranscribeModelState[] }> {
		const settings = readTranscribeSettings();
		const models = await Promise.all(
			BUILTIN_TRANSCRIBE_MODELS.map(async (model) => {
				const download = this.downloads.get(model.id);
				const cached = (await findDownloadedModel(getLookDir(), model)) !== undefined;
				return {
					id: model.id,
					name: model.name,
					size: model.size,
					cached,
					downloading: download?.status === "downloading",
					progress:
						download && download.status === "downloading"
							? Math.round((download.done / download.total) * 100)
							: null,
					languages: [...model.languages],
					streaming: model.streaming,
					highlights: [...model.highlights],
					error: download?.status === "error" ? download.error : undefined,
				};
			}),
		);
		return { settings, models };
	}

	async setSettings(patch: {
		modelId?: string;
		transcriptionLanguage?: string;
		chineseOutput?: (typeof CHINESE_OUTPUTS)[number];
	}): Promise<TranscribeSettings> {
		const current = readTranscribeSettings();
		let next: TranscribeSettings = { ...current };
		if (patch.modelId !== undefined) {
			if (!getBuiltinTranscribeModel(patch.modelId)) {
				throw new Error(`Unknown transcription model: ${patch.modelId}`);
			}
			next = { ...next, modelId: patch.modelId };
		}
		if (patch.transcriptionLanguage !== undefined) {
			next = { ...next, transcriptionLanguage: patch.transcriptionLanguage };
		}
		if (patch.chineseOutput !== undefined) {
			if (!CHINESE_OUTPUTS.includes(patch.chineseOutput)) {
				throw new Error(`Invalid chineseOutput: ${patch.chineseOutput}`);
			}
			next = { ...next, chineseOutput: patch.chineseOutput };
		}
		await writeTranscribeSettings(next);
		return readTranscribeSettings();
	}

	/** 触发模型下载（异步执行；重复调用幂等）。 */
	async download(modelId: string): Promise<void> {
		const model = getBuiltinTranscribeModel(modelId);
		if (!model) throw new Error(`Unknown transcription model: ${modelId}`);
		const existing = this.downloads.get(modelId);
		if (existing?.status === "downloading") return;
		if ((await findDownloadedModel(getLookDir(), model)) !== undefined) {
			this.downloads.set(modelId, { done: model.size, total: model.size, status: "done" });
			return;
		}
		this.downloads.set(modelId, { done: 0, total: model.size, status: "downloading" });
		// 下载在后台进行，返回后由渲染端轮询 getState 获取进度。
		return downloadModel(getLookDir(), model, {
			onProgress: (progress) => {
				const state = this.downloads.get(modelId);
				if (state) {
					state.done = progress.downloaded;
					state.total = progress.total;
				}
			},
		})
			.then(() => {
				this.downloads.set(modelId, { done: model.size, total: model.size, status: "done" });
			})
			.catch((error: unknown) => {
				this.downloads.set(modelId, {
					done: 0,
					total: model.size,
					status: "error",
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			});
	}

	/** 删除已下载的模型文件（正在下载的任务会先中止失败，由调用方兜底）。 */
	async deleteModel(modelId: string): Promise<void> {
		const model = getBuiltinTranscribeModel(modelId);
		if (!model) throw new Error(`Unknown transcription model: ${modelId}`);
		const dir = transcribeModelDir(getLookDir(), model);
		await rm(dir, { recursive: true, force: true });
		this.downloads.delete(modelId);
	}
}

export type { TranscribeModelInfo };

let singleton: TranscribeManager | undefined;

/** 主进程级单例：Look 为单窗口应用，模型资产状态全局共享。 */
export function getTranscribeManager(): TranscribeManager {
	singleton ??= new TranscribeManager();
	return singleton;
}
