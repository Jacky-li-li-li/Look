// ============================================================
// Auth atoms — login state + user profile (Jotai)
// Referencing Proma's atoms/user-profile.ts pattern
// ============================================================

import { atom } from "jotai";
import type { UserProfile } from "../types/user-profile";
import { DEFAULT_USER_AVATAR, DEFAULT_USER_NAME } from "../types/user-profile";

/**
 * 三态登录态：
 * - null  = 未知（启动中，等待 auth 检查完成）
 * - true  = 已登录
 * - false = 未登录
 *
 * 初始为 null 防止 App 乐观渲染 AppLayout 后闪现回 LoginScreen。
 */
export const isLoggedInAtom = atom<boolean | null>(null);

/**
 * authLoading 初始 true — 挂载时立即显示加载态，避免 LoginScreen 或 AppLayout 提前渲染。
 * useAuthSession 确认登录状态后置为 false。
 */
export const authLoadingAtom = atom(true);

export const userProfileAtom = atom<UserProfile>({
	userId: "",
	email: "",
	userName: DEFAULT_USER_NAME,
	avatar: DEFAULT_USER_AVATAR,
});
