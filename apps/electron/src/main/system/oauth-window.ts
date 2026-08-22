// ============================================================
// OAuthWindow — Supabase OAuth 授权窗口控制器
//
// 从 system-router 下沉的窗口编排：sandbox 授权 BrowserWindow
// 生命周期、多路导航事件 + look:// protocol 回调监听、
// redirect 白名单兜底（Supabase 回退 Site URL 时带 token 的
// 隐式流匹配）与 5 分钟超时。router 只做参数守卫。
// ============================================================

import { BrowserWindow } from "electron";
import { safeUrlForLog, setOAuthCallbackListener } from "./oauth-callback.js";

/** 判别联合：成功必带 redirectUrl，失败必带 error（IpcResult 兼容形状）。 */
export type OAuthWindowResult = { success: true; redirectUrl: string } | { success: false; error: string };

const OAUTH_WINDOW_TIMEOUT_MS = 5 * 60 * 1000;

export function openOAuthWindow(url: string, redirectTo: string): Promise<OAuthWindowResult> {
	return new Promise<OAuthWindowResult>((resolve) => {
		const authWindow = new BrowserWindow({
			width: 800,
			height: 700,
			title: "Authorize Look",
			autoHideMenuBar: true,
			webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
		});

		let resolved = false;
		let fallbackTimer: NodeJS.Timeout | null = null;
		let lastCandidateUrl: string | null = null;
		const done = (result: OAuthWindowResult) => {
			if (resolved) return;
			resolved = true;
			if (fallbackTimer) clearTimeout(fallbackTimer);
			clearTimeout(timeoutTimer);
			setOAuthCallbackListener(null);
			if (!authWindow.isDestroyed()) authWindow.destroy();
			resolve(result);
		};

		// Never let the login UI spin forever if the flow gets lost
		// (misconfigured redirect whitelist, network failure, etc.).
		const timeoutTimer = setTimeout(() => {
			done({ success: false, error: "Authorization timed out" });
		}, OAUTH_WINDOW_TIMEOUT_MS);

		const redirectMatcher = (candidate: string) => candidate.startsWith(redirectTo);
		const hasCredentials = (candidate: string) => /[?&#](code|access_token|error)=/.test(candidate);
		// #access_token only ever appears on the final session callback. Match it
		// on any URL so a redirect_to whitelist miss (Supabase falls back to the
		// project Site URL with tokens appended) still completes the login.
		const hasImplicitTokens = (candidate: string) => candidate.includes("#access_token=");

		const handleCandidate = (candidate: string, source: string) => {
			if (!redirectMatcher(candidate) && !hasImplicitTokens(candidate)) return;
			console.log(`[OAuth] callback candidate via ${source}: ${safeUrlForLog(candidate)}`);
			lastCandidateUrl = candidate;
			if (hasCredentials(candidate)) {
				done({ success: true, redirectUrl: candidate });
			} else if (!fallbackTimer) {
				// The protocol handler never sees URL fragments; give the
				// navigation events a beat to deliver the full URL first.
				fallbackTimer = setTimeout(() => {
					if (lastCandidateUrl) done({ success: true, redirectUrl: lastCandidateUrl });
				}, 300);
			}
		};

		// Deterministic backstop: the look:// protocol handler always fires
		// once the window follows the final redirect (no URL fragment).
		setOAuthCallbackListener((candidate) => handleCandidate(candidate, "protocol"));
		// HTTP 3xx redirects
		authWindow.webContents.on("will-redirect", (_event, candidate) => handleCandidate(candidate, "will-redirect"));
		// Explicit navigations (location.href = ..., etc.)
		authWindow.webContents.on("will-navigate", (_event, candidate) => handleCandidate(candidate, "will-navigate"));
		// Navigation completed — catches some JS-based redirects
		authWindow.webContents.on("did-navigate", (_event, candidate) => handleCandidate(candidate, "did-navigate"));
		// SPA / hash-based navigation fallback
		authWindow.webContents.on("did-navigate-in-page", (_event, candidate) =>
			handleCandidate(candidate, "did-navigate-in-page"),
		);

		// Prevent OAuth provider from opening the callback in an external browser
		authWindow.webContents.setWindowOpenHandler(({ url: candidate }) => {
			handleCandidate(candidate, "window-open");
			return { action: "deny" };
		});

		authWindow.on("closed", () => {
			done({ success: false, error: "Authorization window closed" });
		});

		authWindow.loadURL(url);
	});
}
