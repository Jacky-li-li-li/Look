// ============================================================
// Supabase client — cloud auth + profile sync
//
// Single-client singleton. `getSupabase()` returns the same
// `SupabaseClient` instance on every call so Supabase's
// GoTrueClient never warns about duplicate instances sharing
// the same storage key.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

// These are Vite env vars (VITE_ prefix), exposed to renderer.
// Anon key is safe to embed in client code.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? "";
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

/**
 * Cloud auth is optional. Keep the client nullable so the documented local
 * mode can boot without VITE_SUPABASE_* values instead of throwing during
 * module evaluation and leaving the renderer on a blank screen.
 */

let client: SupabaseClient | null = null;
let clientPromise: Promise<SupabaseClient | null> | null = null;
let lastPersistSession = true;

function readRememberMe(): boolean {
	try {
		return localStorage.getItem("look_remember_me") !== "0";
	} catch {
		return true;
	}
}

export function getSupabase(): Promise<SupabaseClient | null> {
	if (!isSupabaseConfigured()) return Promise.resolve(null);
	const persistSession = readRememberMe();
	// Already have a client with the right config — return immediately
	if (client && lastPersistSession === persistSession) return Promise.resolve(client);
	// Creating for the first time, or persistSession changed
	if (!clientPromise || lastPersistSession !== persistSession) {
		lastPersistSession = persistSession;
		clientPromise = import("@supabase/supabase-js")
			.then(({ createClient }) => {
				client = createClient(supabaseUrl, supabaseAnonKey, {
					auth: {
						persistSession,
						autoRefreshToken: persistSession,
						storage: persistSession ? undefined : globalThis.sessionStorage,
						// OAuth redirects are handled manually (exchangeCodeForSession /
						// setSession from the captured callback URL). Auto-detection would
						// let a second app instance inside the OAuth window consume the
						// callback instead.
						detectSessionInUrl: false,
					},
				});
				return client;
			})
			.catch((error: unknown) => {
				client = null;
				clientPromise = null;
				console.error("[Look] Failed to load Supabase client", error);
				return null;
			});
	}
	return clientPromise;
}

/**
 * 重置 Supabase 客户端，使 remember-me 偏好在下一次 getSupabase() 时生效。
 */
export function resetSupabaseClient(): void {
	client = null;
	clientPromise = null;
}

export function isSupabaseConfigured(): boolean {
	return supabaseUrl.length > 0 && supabaseAnonKey.length > 0;
}
