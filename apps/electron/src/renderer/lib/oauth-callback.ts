// ============================================================
// OAuth callback parsing — Supabase account sign-in (GitHub/Google)
//
// The main process captures the final redirect URL (OAUTH_REDIRECT_URL)
// and hands it to the renderer. Supabase delivers credentials in one of
// two shapes depending on the project's auth flow setting:
//   - PKCE (default):  look://auth/callback?code=...
//   - Implicit:        look://auth/callback#access_token=...&refresh_token=...
// Errors can arrive in either the query or the fragment.
// ============================================================

import { OAUTH_REDIRECT_URL } from "@shared/contracts/ipc";

export { OAUTH_REDIRECT_URL };

export type OAuthCallback =
	| { type: "code"; code: string }
	| { type: "tokens"; accessToken: string; refreshToken: string }
	| { type: "error"; error: "invalid-url" | "no-credentials" | (string & {}) };

export function parseOAuthCallback(redirectUrl: string): OAuthCallback {
	let url: URL;
	try {
		url = new URL(redirectUrl);
	} catch {
		return { type: "error", error: "invalid-url" };
	}

	const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
	const error = url.searchParams.get("error") ?? hashParams.get("error");
	if (error) {
		const description = url.searchParams.get("error_description") ?? hashParams.get("error_description") ?? error;
		return { type: "error", error: description };
	}

	const code = url.searchParams.get("code");
	if (code) return { type: "code", code };

	const accessToken = hashParams.get("access_token");
	const refreshToken = hashParams.get("refresh_token");
	if (accessToken && refreshToken) return { type: "tokens", accessToken, refreshToken };

	return { type: "error", error: "no-credentials" };
}
