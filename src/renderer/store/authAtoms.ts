// ============================================================
// Auth atoms — login state + user profile (Jotai)
// Referencing Proma's atoms/user-profile.ts pattern
// ============================================================

import { atom } from "jotai";
import type { UserProfile } from "../types/user-profile";
import { DEFAULT_USER_AVATAR, DEFAULT_USER_NAME, DEFAULT_USER_ROLE } from "../types/user-profile";

/** 乐观假设已登录——本地 Electron 应用，auth 检查几乎瞬时完成。异步检查后若未登录再切到 LoginScreen。 */
export const isLoggedInAtom = atom(true);

/** authLoading 初始 false——不阻塞 UI 首屏渲染。仅 Supabase 模式下网络校验期间短暂为 true。 */
export const authLoadingAtom = atom(false);

export const userProfileAtom = atom<UserProfile>({
	userId: "",
	email: "",
	userName: DEFAULT_USER_NAME,
	handle: "",
	role: DEFAULT_USER_ROLE,
	avatar: DEFAULT_USER_AVATAR,
});
