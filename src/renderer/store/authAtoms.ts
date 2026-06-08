// ============================================================
// Auth atoms — login state + user profile (Jotai)
// Referencing Proma's atoms/user-profile.ts pattern
// ============================================================

import { atom } from "jotai";
import type { UserProfile } from "../types/user-profile";
import { DEFAULT_USER_AVATAR, DEFAULT_USER_NAME } from "../types/user-profile";

export const isLoggedInAtom = atom(false);

export const authLoadingAtom = atom(true);

export const userProfileAtom = atom<UserProfile>({
	userId: "",
	email: "",
	userName: DEFAULT_USER_NAME,
	avatar: DEFAULT_USER_AVATAR,
});
