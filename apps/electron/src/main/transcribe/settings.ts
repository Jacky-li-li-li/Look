// ============================================================
// Transcribe — 设置存储（$LOOK_HOME/transcribe.json）
//
// Phase 1 精简版：模型 + 语言 + 中文输出。原子写入 + 0600 权限，
// 非法内容自动回退默认值（不阻塞使用）。
// ============================================================

import { join } from "node:path";
import { getLookDir } from "@look/shared";
import { readJsonFileOptional, writeJsonFileAsync } from "../utils/atomic-writer.js";

export type ChineseOutput = "simplified" | "traditional-taiwan" | "traditional-hong-kong";

export type TranscribeSettings = {
	version: 1;
	/** 内置模型 id（见 model-catalog）。 */
	modelId: string;
	/** "auto" 或模型支持的具体语言代码（如 zh / zh-CN）。 */
	transcriptionLanguage: string;
	chineseOutput: ChineseOutput;
};

export const DEFAULT_TRANSCRIBE_SETTINGS: TranscribeSettings = {
	version: 1,
	modelId: "Qwen3-ASR-0.6B",
	transcriptionLanguage: "auto",
	chineseOutput: "simplified",
};

function transcribeSettingsPath(): string {
	return join(getLookDir(), "transcribe.json");
}

function defaultChineseOutput(): ChineseOutput {
	const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
	if (locale.includes("hk") || locale.includes("mo")) return "traditional-hong-kong";
	if (locale.includes("tw") || locale.includes("hant")) return "traditional-taiwan";
	return "simplified";
}

function normalizeChineseOutput(value: unknown): ChineseOutput {
	// 三个合法值都原样保留 —— 缺失/非法才回退 locale 默认，
	// 否则 zh-TW/zh-HK 系统上用户显式选择的 "simplified" 会被静默改回繁体。
	if (value === "simplified" || value === "traditional-taiwan" || value === "traditional-hong-kong") {
		return value;
	}
	return defaultChineseOutput();
}

function normalize(value: unknown): TranscribeSettings {
	const record = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
	const modelId =
		typeof record.modelId === "string" && record.modelId.length > 0
			? record.modelId
			: DEFAULT_TRANSCRIBE_SETTINGS.modelId;
	const transcriptionLanguage =
		typeof record.transcriptionLanguage === "string" && record.transcriptionLanguage.length > 0
			? record.transcriptionLanguage
			: "auto";
	return {
		version: 1,
		modelId,
		transcriptionLanguage,
		chineseOutput: normalizeChineseOutput(record.chineseOutput),
	};
}

export function readTranscribeSettings(): TranscribeSettings {
	const raw = readJsonFileOptional<unknown>(transcribeSettingsPath());
	return normalize(raw);
}

export function writeTranscribeSettings(settings: TranscribeSettings): Promise<void> {
	return writeJsonFileAsync(transcribeSettingsPath(), settings);
}
