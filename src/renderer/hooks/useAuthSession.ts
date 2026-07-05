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
import { isSupabaseConfigured, supabase } from "../lib/supabase";
import { authLoadingAtom, isLoggedInAtom, userProfileAtom } from "../store/authAtoms";

const api = (window as any).look;

export function useAuthSession() {
	const [isLoggedIn, setIsLoggedIn] = useAtom(isLoggedInAtom);
	const [authLoading, setAuthLoading] = useAtom(authLoadingAtom);
	const [, setUserProfile] = useAtom(userProfileAtom);

	useEffect(() => {
		if (!api) {
			setIsLoggedIn(false);
			setAuthLoading(false);
			return;
		}

		let cancelled = false;

		/**
		 * 立即加载本地 profile——IPC 到主进程读写 ~/.look/user-profile.json，
		 * 同步 I/O，头像秒显。
		 */
		api.getUserProfile()
			.then((r: any) => {
				if (cancelled) return;
				if (r?.success && r.profile?.userId) {
					setUserProfile(r.profile);
				}
			})
			.catch(() => {});

		const configured = isSupabaseConfigured();

		async function restoreSession() {
			if (!configured) {
				// 本地模式：步骤 1 已拉取本地 profile，直接登录
				if (!cancelled) {
					setIsLoggedIn(true);
					setAuthLoading(false);
				}
				return;
			}

			// Supabase 模式：后台校验会话，仅在校验失败时切到 LoginScreen。
			const {
				data: { session },
			} = await supabase.auth.getSession();

			if (cancelled) return;

			if (session?.user) {
				// 从云端拉取最新资料，覆盖本地缓存
				const { data: cloudProfile } = await supabase
					.from("user_profiles")
					.select("user_name, avatar")
					.eq("id", session.user.id)
					.single();

				if (cancelled) return;

				if (cloudProfile) {
					setUserProfile({
						userId: session.user.id,
						email: session.user.email ?? "",
						userName: cloudProfile.user_name || session.user.email || "",
						avatar: cloudProfile.avatar || "",
					});
				} else {
					// 云端无记录 → 回退到本地 profile（已在步骤 1 加载）
					try {
						const r = await api.getUserProfile();
						if (!cancelled && r?.success && r.profile?.userId === session.user.id) {
							setUserProfile(r.profile);
						}
					} catch {
						if (!cancelled) {
							setUserProfile({
								userId: session.user.id,
								email: session.user.email ?? "",
								userName: session.user.email ?? "",
								avatar: "",
							});
						}
					}
				}
				if (!cancelled) {
					setIsLoggedIn(true);
					setAuthLoading(false);
				}
			} else {
				// 无 Supabase 会话 → 检查本地 profile
				try {
					const r = await api.getUserProfile();
					if (!cancelled && r?.success && r.profile?.userId) {
						setUserProfile(r.profile);
						setIsLoggedIn(true);
						setAuthLoading(false);
						return;
					}
				} catch {}
				if (!cancelled) {
					setIsLoggedIn(false);
					setAuthLoading(false);
				}
			}
		}

		restoreSession();

		return () => {
			cancelled = true;
		};
	}, [setIsLoggedIn, setUserProfile, setAuthLoading]);

	return { isLoggedIn, authLoading };
}
