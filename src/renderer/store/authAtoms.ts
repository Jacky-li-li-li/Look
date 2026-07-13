// ============================================================
// Auth atoms — login state + user profile (Jotai)
// Referencing Proma's atoms/user-profile.ts pattern
// ============================================================

import { atom } from "jotai";
import { readAuthCache } from "../lib/authCache";
import type { UserProfile } from "../types/user-profile";
import { DEFAULT_USER_AVATAR, DEFAULT_USER_NAME } from "../types/user-profile";

const cached = readAuthCache();

/** 默认未登录；异步 auth 检查完成后根据本地 profile / Supabase 会话切到已登录。 */
export const isLoggedInAtom = atom(!!cached?.userId);

/**
 * 不再用全局 loading 页阻塞首屏。刷新时若存在 auth cache，直接渲染主界面并在后台校验；
 * 无 cache 时首屏即显示登录页。各操作仍可在需要时局部设置 authLoading。
 */
export const authLoadingAtom = atom(false);

export const userProfileAtom = atom<UserProfile>({
	userId: cached?.userId ?? "",
	email: cached?.email ?? "",
	userName: cached?.userName ?? DEFAULT_USER_NAME,
	handle: cached?.handle ?? "",
	avatar: cached?.avatar ?? DEFAULT_USER_AVATAR,
});
