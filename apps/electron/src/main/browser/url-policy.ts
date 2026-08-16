// ============================================================
// Browser URL policy — 导航 URL 安全白名单
//
// 被 browser-extension（agent 工具）与 browser-service（内置浏览器
// 面板的用户导航）共用，保证两条入口使用同一套协议安全策略。
// ============================================================

/** 允许导航的 URL 协议（含冒号）。拒绝 file:/javascript:/data: 等本地/可执行协议。 */
export const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:", "about:"]);

export function assertSafeUrl(url: string | undefined): void {
	if (!url) return;
	const trimmed = url.trim();
	if (!trimmed) return;
	// 无协议前缀的裸地址（如 example.com）按 http 处理，直接放行；
	// 有协议前缀时必须命中白名单。
	const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
	if (schemeMatch && !ALLOWED_URL_PROTOCOLS.has(`${schemeMatch[1].toLowerCase()}:`)) {
		throw new Error(
			`Refusing to navigate to disallowed protocol "${schemeMatch[1]}:". Only http:, https: (or a bare domain) are allowed.`,
		);
	}
}

/**
 * 校验并规范化导航 URL。
 *
 * 返回可供 WebContents.loadURL 直接导航的绝对 URL：
 * - 裸域名 / 裸路径（无协议前缀，如 `example.com/path`）补 `http://`——
 *   loadURL 需要绝对 URL，不带协议会导航失败；
 * - 有协议前缀的（http:/https:/about:）原样返回；
 * - 非法协议（file:/javascript:/data: 等）抛错拒绝。
 */
export function normalizeNavigationUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	assertSafeUrl(url);
	const trimmed = url.trim();
	if (!trimmed) return undefined;
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
	// 裸地址：补 http://（与 assertSafeUrl 的放行语义一致）。
	return `http://${trimmed}`;
}
