// ============================================================
// Supabase client — cloud auth + profile sync
// ============================================================

import { createClient } from "@supabase/supabase-js";

// These are Vite env vars (VITE_ prefix), exposed to renderer.
// Anon key is safe to embed in client code.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? "";
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
	auth: {
		persistSession: true,
		autoRefreshToken: true,
	},
});

export function isSupabaseConfigured(): boolean {
	return supabaseUrl.length > 0 && supabaseAnonKey.length > 0;
}
