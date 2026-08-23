// ============================================================
// Transcribe — transcribe.cpp 后端封装
//
// 从 pi-transcribe 移植（MIT）：单模型驻留、懒加载、可中止。
// 语言匹配做了宽松化：配置 "zh" 时也能命中 "zh-CN" 等变体，
// 避免 Qwen3("zh") / nemotron("zh-CN") 语言代码粒度不一致的坑。
// ============================================================

import type { TranscribeModel } from "transcribe-cpp";
import { convertChineseOutput, isChineseLanguage } from "./chinese.js";
import type { ChineseOutput } from "./settings.js";

export type TranscriptionOptions = {
	signal?: AbortSignal;
	language?: string;
	chineseOutput?: ChineseOutput;
};

/** 宽松匹配：语言列表是否支持目标语言（zh 命中 zh-CN）。 */
export function languagesSupportLanguage(languages: readonly string[], language: string): boolean {
	const wanted = language.toLowerCase().split("-", 1)[0];
	return languages.some((supported) => {
		const base = supported.toLowerCase().split("-", 1)[0];
		return base === wanted || supported.toLowerCase() === language.toLowerCase();
	});
}

/** 宽松匹配：模型语言列表是否支持目标语言（zh 命中 zh-CN）。 */
export function modelSupportsLanguage(model: TranscribeModel, language: string): boolean {
	return languagesSupportLanguage(model.capabilities.languages, language);
}

export class TranscribeCppBackend {
	private model: TranscribeModel | undefined;
	private loading: Promise<TranscribeModel> | undefined;
	private disposed = false;

	constructor(private readonly modelPath: string) {}

	async prepare(): Promise<void> {
		if (this.model) return;
		if (this.disposed) throw new Error("Transcription backend has been disposed");

		if (!this.loading) {
			this.loading = import("transcribe-cpp")
				.then(({ TranscribeModel }) => TranscribeModel.load(this.modelPath))
				.then((model) => {
					if (this.disposed) {
						model.dispose();
						throw new Error("Transcription backend was disposed while loading");
					}
					this.model = model;
					return model;
				});
		}

		try {
			await this.loading;
		} finally {
			this.loading = undefined;
		}
	}

	async transcribe(pcm: Float32Array, options: TranscriptionOptions = {}): Promise<string> {
		if (pcm.length === 0) throw new Error("No audio samples were provided");
		await this.prepare();
		const model = this.model!;
		if (options.language && options.language !== "auto" && !modelSupportsLanguage(model, options.language)) {
			throw new Error(
				`Configured language ${options.language} is not supported by this model. Switch to "auto" or choose a supported language.`,
			);
		}

		const result = await model.transcribe(pcm, {
			signal: options.signal,
			timestamps: "none",
			...(options.language && options.language !== "auto" ? { language: options.language } : {}),
		});
		const text = result.text.trim();
		const detected = result.language || options.language || "";
		return isChineseLanguage(detected)
			? await convertChineseOutput(text, options.chineseOutput ?? "simplified")
			: text;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.loading?.catch(() => undefined);
		this.model?.dispose();
		this.model = undefined;
	}
}
