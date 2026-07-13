// ============================================================
// useAuthSession — 登录态管理 + 用户资料加载
//
// 优化策略：
//   1. 挂载时立即通过 IPC 拉取本地 profile（~/.look/user-profile.json）
//      磁盘同步读取，仅受 IPC 往返影响（<1ms），头像秒显。
//   2. 如果 Supabase 已配置，后台异步校验会话 + 拉取云端资料，
//      到达后覆盖本地值。
//   3. 如果 Supabase 未配置（本地模式），步骤 1 即完成加载。
// ============================================================

import { useAtom } from "jotai";
import { useEffect } from "react";
import { clearAuthCache, writeAuthCache } from "../lib/authCache";
import { getSupabase, isSupabaseConfigured } from "../lib/supabase";
import { authLoadingAtom, isLoggedInAtom, userProfileAtom } from "../store/authAtoms";

const api = window.look;

export function useAuthSession() {
	const [isLoggedIn, setIsLoggedIn] = useAtom(isLoggedInAtom);
	const [authLoading, _setAuthLoading] = useAtom(authLoadingAtom);
	const [, setUserProfile] = useAtom(userProfileAtom);

	useEffect(() => {
		if (!api) return;

		let cancelled = false;

		/**
		 * 立即加载本地 profile——IPC 到主进程读写 ~/.look/user-profile.json，
		 * 同步 I/O，头像秒显。
		 */
		api.getUserProfile()
			.then((r) => {
				if (cancelled) return;
				if (r?.success && r.profile?.userId) {
					setUserProfile(r.profile);
					writeAuthCache(r.profile);
				}
			})
			.catch(() => {});

		// Browser mock scenarios are deterministic renderer fixtures and must not
		// be replaced by a real Supabase session from the developer's .env.
		const isBrowserMock = import.meta.env.DEV && new URLSearchParams(window.location.search).has("mock");
		const configured = isSupabaseConfigured() && !isBrowserMock;

		async function restoreSession() {
			// 刷新时不进入全屏 loading；后台校验，失败再转登录页。
			_setAuthLoading(false);

			try {
				if (!configured) {
					// 本地模式：仅依赖本地 profile
					const r = await api.getUserProfile();
					if (!cancelled && r?.success && r.profile?.userId) {
						setUserProfile(r.profile);
						writeAuthCache(r.profile);
						setIsLoggedIn(true);
					} else if (!cancelled) {
						clearAuthCache();
						setIsLoggedIn(false);
					}
					return;
				}

				const supabase = await getSupabase();
				if (!supabase || cancelled) {
					if (!cancelled) {
						clearAuthCache();
						setIsLoggedIn(false);
					}
					return;
				}

				// Supabase 模式：后台校验会话
				const {
					data: { session },
				} = await supabase.auth.getSession();

				if (cancelled) return;

				if (session?.user) {
					const { data: cloudProfile } = await supabase
						.from("user_profiles")
						.select("user_name, avatar")
						.eq("id", session.user.id)
						.single();

					if (cancelled) return;

					setUserProfile((prev) => {
						let next: import("../types/user-profile").UserProfile;
						if (cloudProfile) {
							next = {
								...prev,
								userId: session.user.id,
								email: session.user.email ?? prev.email,
								userName: cloudProfile.user_name || session.user.email || prev.userName || "You",
								avatar: cloudProfile.avatar || prev.avatar,
							};
						} else {
							next = {
								...prev,
								userId: session.user.id,
								email: session.user.email ?? prev.email,
								userName: session.user.email || prev.userName || "You",
							};
						}
						writeAuthCache(next);
						return next;
					});
					setIsLoggedIn(true);
				} else {
					// 无 Supabase 会话 → 不再仅凭本地 profile 视为已登录
					if (!cancelled) {
						clearAuthCache();
						setIsLoggedIn(false);
					}
				}
			} finally {
				if (!cancelled) _setAuthLoading(false);
			}
		}

		restoreSession();

		return () => {
			cancelled = true;
		};
	}, [setIsLoggedIn, setUserProfile, _setAuthLoading]);

	return { isLoggedIn, authLoading };
}
