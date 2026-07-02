// ============================================================
// Auth atoms — login state + user profile (Jotai)
// Referencing Proma's atoms/user-profile.ts pattern
// ============================================================

import { atom } from "jotai";
import type { UserProfile } from "../types/user-profile";
import { DEFAULT_USER_AVATAR, DEFAULT_USER_NAME } from "../types/user-profile";

/** 乐观假设已登录——避免 Supabase 网络延迟卡启动。异步检查后若未登录再切到 LoginScreen。 */
export const isLoggedInAtom = atom(true);

/** authLoading 初始 false——不阻塞 UI 首屏渲染。 */
export const authLoadingAtom = atom(false);

export const userProfileAtom = atom<UserProfile>({
	userId: "",
	email: "",
	userName: DEFAULT_USER_NAME,
	avatar: DEFAULT_USER_AVATAR,
});
