// ============================================================
// 外链打开策略
//
// - https：直接交给系统浏览器；
// - http：明文链接可被中间人篡改，打开前需用户确认（向后兼容：仍可打开）；
// - 其他协议（file:/javascript:/自定义 scheme 等）：一律拒绝。
// ============================================================

export type ExternalUrlDecision = "open" | "confirm" | "deny";

export function classifyExternalUrl(raw: string): ExternalUrlDecision {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return "deny";
	}
	if (url.protocol === "https:") return "open";
	if (url.protocol === "http:") return "confirm";
	return "deny";
}

export interface OpenExternalDeps {
	openExternal: (url: string) => Promise<void>;
	/** 返回 true 表示用户确认打开。 */
	confirm: (url: string) => Promise<boolean>;
	logger?: Pick<Console, "error">;
}

export async function openExternalWithPolicy(raw: string, deps: OpenExternalDeps): Promise<boolean> {
	const decision = classifyExternalUrl(raw);
	if (decision === "deny") return false;
	if (decision === "confirm" && !(await deps.confirm(raw))) return false;
	try {
		await deps.openExternal(raw);
		return true;
	} catch (error) {
		(deps.logger ?? console).error("[Look] Failed to open external URL:", error);
		return false;
	}
}
