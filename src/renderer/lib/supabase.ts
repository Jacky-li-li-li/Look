// ============================================================
// Supabase client — cloud auth + profile sync
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
let clientPromise: Promise<SupabaseClient | null> | null = null;

export function getSupabase(): Promise<SupabaseClient | null> {
	if (!isSupabaseConfigured()) return Promise.resolve(null);
	if (!clientPromise) {
		clientPromise = import("@supabase/supabase-js")
			.then(({ createClient }) =>
				createClient(supabaseUrl, supabaseAnonKey, {
					auth: {
						persistSession: true,
						autoRefreshToken: true,
					},
				}),
			)
			.catch((error: unknown) => {
				clientPromise = null;
				console.error("[Look] Failed to load Supabase client", error);
				return null;
			});
	}
	return clientPromise;
}

export function isSupabaseConfigured(): boolean {
	return supabaseUrl.length > 0 && supabaseAnonKey.length > 0;
}
