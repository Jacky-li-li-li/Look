// ============================================================
// useHighlighter — shiki 高亮单例 + 异步高亮 hook
//
// 高亮必须走 createHighlighter 显式传入 JS 引擎：codeToHtml 简写会丢弃
// engine 参数（单例 highlighter 始终回退 Oniguruma WASM），而 WASM 被
// CSP script-src 拦截。与 @streamdown/code 共用
// createJavaScriptRegexEngine({ forgiving: true }) 方案。
//
// 拆出自 FileViewerDialog：shiki 单例 + 语言按需加载是自足关注点，
// 且 hook 化后高亮竞态保护（cancelled 标志）可被单测覆盖。
// ============================================================

import pierreDark from "@pierre/theme/pierre-dark";
import pierreLight from "@pierre/theme/pierre-light";
import { useEffect, useState } from "react";
import { createHighlighter, type HighlighterGeneric, type ThemeRegistrationRaw } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

type ViewerHighlighter = HighlighterGeneric<string, string>;

let highlighterPromise: Promise<ViewerHighlighter> | null = null;
const loadedLanguages = new Set<string>();

// @pierre/theme 的主题是 VS Code/TextMate 格式，shiki 接受该格式；
// TS 类型差异（readonly 数组）用断言桥接。
const PIERRE_LIGHT = pierreLight as unknown as ThemeRegistrationRaw;
const PIERRE_DARK = pierreDark as unknown as ThemeRegistrationRaw;

/** 初始化（幂等）并返回 shiki highlighter 单例。 */
async function getHighlighter(): Promise<ViewerHighlighter> {
	highlighterPromise ??= createHighlighter({
		// 与 @pierre/diffs 的 diff 预览统一用 pierre 主题（Proma 同款）
		themes: [PIERRE_LIGHT, PIERRE_DARK],
		langs: [],
		engine: createJavaScriptRegexEngine({ forgiving: true }),
	}) as Promise<ViewerHighlighter>;
	return highlighterPromise;
}

/** 高亮一段代码为双主题 HTML，语言按需加载。 */
export async function highlightCodeContent(code: string, lang: string): Promise<string> {
	const highlighter = await getHighlighter();
	if (!loadedLanguages.has(lang)) {
		await highlighter.loadLanguage(lang as never);
		loadedLanguages.add(lang);
	}
	return highlighter.codeToHtml(code, { lang, themes: { light: PIERRE_LIGHT, dark: PIERRE_DARK } });
}

export { PIERRE_LIGHT, PIERRE_DARK };

/**
 * 对文本内容做 shiki 高亮，带竞态保护（路径/内容变化时旧请求作废）。
 *
 * 返回 `{ highlightedHtml, highlightFailed }`：
 *   - 高亮中 → highlightedHtml=null（调用方渲染 spinner）
 *   - 成功   → highlightedHtml=html
 *   - 失败   → highlightFailed=true（调用方回落到纯 <pre>）
 */
export function useHighlightedHtml(
	content: string | null,
	language: string | null,
): {
	highlightedHtml: string | null;
	highlightFailed: boolean;
} {
	const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
	const [highlightFailed, setHighlightFailed] = useState(false);

	useEffect(() => {
		if (!content || !language) return;
		let cancelled = false;
		setHighlightedHtml(null);
		setHighlightFailed(false);
		highlightCodeContent(content, language)
			.then((html) => {
				if (!cancelled) setHighlightedHtml(html);
			})
			.catch(() => {
				if (!cancelled) setHighlightFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [content, language]);

	return { highlightedHtml, highlightFailed };
}
