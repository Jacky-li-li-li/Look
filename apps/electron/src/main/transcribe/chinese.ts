// ============================================================
// Transcribe — 中文输出转换（OpenCC 简/台繁/港繁）
//
// 从 pi-transcribe 移植（MIT）：按系统 locale 默认简体，
// 支持台湾/香港繁体即时切换。转换器懒加载 + 单例缓存。
// ============================================================

import type { ChineseOutput } from "./settings.js";

type Converter = (text: string) => string;

const converters = new Map<ChineseOutput, Promise<Converter>>();

async function createConverter(output: ChineseOutput): Promise<Converter> {
	const { default: OpenCC } = await import("opencc-js");
	switch (output) {
		case "simplified":
			return OpenCC.Converter({ from: "t", to: "cn" });
		case "traditional-taiwan":
			return OpenCC.Converter({ from: "cn", to: "tw" });
		case "traditional-hong-kong":
			return OpenCC.Converter({ from: "cn", to: "hk" });
	}
}

function converterFor(output: ChineseOutput): Promise<Converter> {
	const existing = converters.get(output);
	if (existing) return existing;
	const loading = createConverter(output);
	converters.set(output, loading);
	void loading.catch(() => {
		if (converters.get(output) === loading) converters.delete(output);
	});
	return loading;
}

/** 语言代码（含 zh-* / yue）是否走中文转换链路。 */
export function isChineseLanguage(language: string): boolean {
	const base = language.toLowerCase().split("-", 1)[0];
	return base === "zh" || base === "yue";
}

export async function convertChineseOutput(text: string, output: ChineseOutput): Promise<string> {
	return (await converterFor(output))(text);
}
