// ============================================================
// Supabase client — cloud auth + profile sync
// ============================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// These are Vite env vars (VITE_ prefix), exposed to renderer.
// Anon key is safe to embed in client code.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? "";
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

/**
 * Cloud auth is optional. Keep the client nullable so the documented local
 * mode can boot without VITE_SUPABASE_* values instead of throwing during
 * module evaluation and leaving the renderer on a blank screen.
 */
export const supabase: SupabaseClient | null =
	supabaseUrl && supabaseAnonKey
		? createClient(supabaseUrl, supabaseAnonKey, {
				auth: {
					persistSession: true,
					autoRefreshToken: true,
				},
			})
		: null;

export function isSupabaseConfigured(): boolean {
	return supabaseUrl.length > 0 && supabaseAnonKey.length > 0;
}
