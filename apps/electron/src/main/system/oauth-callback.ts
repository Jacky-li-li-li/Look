// ============================================================
// OAuth callback capture — look:// custom protocol
//
// Supabase account OAuth (GitHub/Google) redirects to OAUTH_REDIRECT_URL
// (look://auth/callback). This protocol handler is the deterministic
// capture channel: unlike navigation events it always fires once the
// auth window follows the final redirect, and the scheme never resolves
// to a real servable page. Fragments never reach the network layer, so
// hash-based tokens additionally rely on the navigation-event capture
// in the system router.
// ============================================================

import { protocol } from "electron";

type OAuthCallbackListener = (url: string) => void;

let pendingListener: OAuthCallbackListener | null = null;

/** Called by the auth-window flow while it waits for the redirect. */
export function setOAuthCallbackListener(listener: OAuthCallbackListener | null): void {
	pendingListener = listener;
}

/** Strip query/hash so auth tokens never land in logs. */
export function safeUrlForLog(raw: string): string {
	try {
		const url = new URL(raw);
		return `${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		return "<unparseable-url>";
	}
}

/**
 * Handle the look:// scheme. Must be called after app ready; the scheme is
 * registered as privileged (standard + secure) before app ready in index.ts.
 */
export function registerOAuthProtocol(): void {
	protocol.handle("look", (request) => {
		let host = "";
		let pathname = "";
		try {
			const url = new URL(request.url);
			host = url.host;
			pathname = url.pathname;
		} catch {
			// Fall through to the empty response below.
		}
		if (host === "auth" && pathname === "/callback") {
			if (pendingListener) {
				console.log(`[OAuth] callback reached protocol handler: ${safeUrlForLog(request.url)}`);
				pendingListener(request.url);
			} else {
				// Normal race: a navigation event already captured the callback and
				// destroyed the window while this request was still in flight.
				console.log("[OAuth] look://auth/callback reached after capture, ignoring");
			}
		}
		// Never serve real content for the callback scheme. Note: undici rejects
		// a non-null body with 204, so pass null explicitly.
		return new Response(null, { status: 204 });
	});
}
