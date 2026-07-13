// ============================================================
// UserProfile — local user identity
// Stored in ~/.look/user-profile.json, synced with Supabase
// ============================================================

export interface UserProfile {
	userId: string; // Supabase auth.uid()
	email: string;
	userName: string; // display name (replaces "YOU" in chat)
	handle?: string; // @handle shown below the display name
	avatar: string; // base64 data:image URL or emoji string
}

export const DEFAULT_USER_NAME = "You";
export const DEFAULT_USER_AVATAR = "";
