// ============================================================
// Auth cache — lightweight, synchronous UI state used to avoid
// the loading-page flash when the renderer refreshes.
//
// This is *only* a display cache. Actual session validity is still
// verified asynchronously by useAuthSession; if the session is gone
// the app will redirect to the login screen and clear this cache.
// ============================================================

import type { UserProfile } from "../types/user-profile";

const CACHE_KEY = "look_auth_cache";

export interface AuthCache {
	userId: string;
	email: string;
	userName: string;
	handle?: string;
	avatar: string;
}

export function readAuthCache(): AuthCache | null {
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<AuthCache>;
		if (!parsed.userId) return null;
		return {
			userId: parsed.userId,
			email: parsed.email ?? "",
			userName: parsed.userName ?? "You",
			handle: parsed.handle,
			avatar: parsed.avatar ?? "",
		};
	} catch {
		return null;
	}
}

export function writeAuthCache(profile: UserProfile): void {
	try {
		const cache: AuthCache = {
			userId: profile.userId,
			email: profile.email,
			userName: profile.userName,
			handle: profile.handle,
			avatar: profile.avatar,
		};
		localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
	} catch {
		/* ignore storage failures */
	}
}

export function clearAuthCache(): void {
	try {
		localStorage.removeItem(CACHE_KEY);
	} catch {
		/* ignore storage failures */
	}
}
