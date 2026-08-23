// ============================================================
// Transcribe — 内置模型清单
//
// 只内置两个模型（产品决策：覆盖两个核心场景）：
//   - Qwen3-ASR-0.6B   高准确率非流式（文件转写、定稿）
//   - Nemotron 3.5 Streaming  低延迟流式（实时听写，Phase 2 使用）
//
// 元数据来自 pi-transcribe catalog（handy-computer 组织 GGUF 仓库）。
// revision 锁定上游提交；size + sha256 用于下载完整性与防篡改校验。
// ============================================================

export type TranscribeModelInfo = {
	id: string;
	name: string;
	description: string;
	/** Hugging Face 仓库（handy-computer 的 GGUF 转换仓库）。 */
	repository: string;
	/** 锁定的上游 revision（40 位 commit）。 */
	revision: string;
	filename: string;
	size: number;
	sha256: string;
	quant: string;
	parameters: string;
	languages: readonly string[];
	/** 模型架构是否支持流式解码（transcribe.cpp Stream API）。 */
	streaming: boolean;
	languageDetection: boolean;
	/** 差异化亮点（i18n key，设置页展示）。 */
	highlights: readonly string[];
};

export const BUILTIN_TRANSCRIBE_MODELS: readonly TranscribeModelInfo[] = [
	{
		id: "Qwen3-ASR-0.6B",
		name: "Qwen3-ASR 0.6B",
		description: "高准确率中文/多语言转写（非流式），适合文件转写与定稿",
		repository: "handy-computer/Qwen3-ASR-0.6B-gguf",
		revision: "e4e16599b900eb0cb36e524514756bb92eb092b7",
		filename: "Qwen3-ASR-0.6B-Q8_0.gguf",
		size: 850_423_456,
		sha256: "f081b2d5e23bd669d92cc331d722a8a0681943b8e6f34b48996fd5c319b5acd8",
		quant: "Q8_0",
		parameters: "782M",
		languages: ["zh", "en", "yue", "ar", "de", "fr", "es", "pt", "id", "it", "ko", "ru", "th", "vi", "ja"],
		streaming: false,
		languageDetection: true,
		highlights: ["settings.featAccurate", "settings.featMultilingual", "settings.featFileBest"],
	},
	{
		id: "nemotron-3.5-asr-streaming-0.6b",
		name: "Nemotron Streaming 3.5",
		description: "低延迟流式转写（边说边出字），支持中文 zh-CN 与自动语言检测",
		repository: "handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf",
		revision: "6d44e540bc31b0de1dbe174a3cea87f53a7f22fb",
		filename: "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf",
		size: 751_094_240,
		sha256: "b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c",
		quant: "Q8_0",
		parameters: "0.6B",
		languages: [
			"en-US",
			"en-GB",
			"es-US",
			"es-ES",
			"fr-FR",
			"de-DE",
			"ru-RU",
			"ja-JP",
			"ko-KR",
			"zh-CN",
			"pt-BR",
			"it-IT",
		],
		streaming: true,
		languageDetection: true,
		highlights: ["settings.featStreaming", "settings.featLowLatency", "settings.featMicBest"],
	},
];

export function getBuiltinTranscribeModel(id: string): TranscribeModelInfo | undefined {
	return BUILTIN_TRANSCRIBE_MODELS.find((model) => model.id === id);
}

/** 按语言代码推荐内置模型（语言不完全匹配时回退到 Qwen3 多语言款）。 */
export function recommendTranscribeModel(preferredLanguage: string): TranscribeModelInfo {
	const lang = preferredLanguage.toLowerCase().split("-", 1)[0];
	for (const model of BUILTIN_TRANSCRIBE_MODELS) {
		if (model.languages.some((l) => l.toLowerCase().split("-", 1)[0] === lang)) {
			return model;
		}
	}
	return BUILTIN_TRANSCRIBE_MODELS[0];
}
