// ============================================================
// useAuthSession — Supabase 会话恢复 + 登录态管理
//
// 优化：本地模式立即放行；Supabase 模式先放行 UI（authLoading 初始
// false），后台异步恢复会话。避免 2-3s 网络阻塞卡住整个启动画面。
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
		if (!api) return;
		const configured = isSupabaseConfigured();

		async function restoreSession() {
			if (!configured) {
				// 本地模式：乐观假设成立，无需更改
				return;
			}

			// Supabase 模式：后台异步恢复，isLoggedIn 默认为 true（乐观）。
			// 仅在校验失败时翻转为 false → LoginScreen。
			const {
				data: { session },
			} = await supabase.auth.getSession();

			if (session?.user) {
				// 已登录 → 拉取云端资料
				const { data: cloudProfile } = await supabase
					.from("user_profiles")
					.select("user_name, avatar")
					.eq("id", session.user.id)
					.single();

				if (cloudProfile) {
					setUserProfile({
						userId: session.user.id,
						email: session.user.email ?? "",
						userName: cloudProfile.user_name || session.user.email || "",
						avatar: cloudProfile.avatar || "",
					});
				} else {
					try {
						const r = await api.getUserProfile();
						if (r?.success && r.profile?.userId === session.user.id) {
							setUserProfile(r.profile);
						} else {
							setUserProfile({
								userId: session.user.id,
								email: session.user.email ?? "",
								userName: session.user.email ?? "",
								avatar: "",
							});
						}
					} catch {
						setUserProfile({
							userId: session.user.id,
							email: session.user.email ?? "",
							userName: session.user.email ?? "",
							avatar: "",
						});
					}
				}
				// isLoggedIn 已经是 true（乐观），无需再设
			} else {
				// 无会话 → 检查本地 profile，有的话也算已登录
				try {
					const r = await api.getUserProfile();
					if (r?.success && r.profile?.userId) {
						setUserProfile(r.profile);
						return; // isLoggedIn 保持 true
					}
				} catch {}
				// 校验失败 → 翻转为未登录
				setIsLoggedIn(false);
			}
		}

		restoreSession();
	}, [setIsLoggedIn, setUserProfile]);

	// Supabase 模式下不阻塞 UI——先渲染界面，后台异步恢复。
	// 结果到达后若未登录再切到 LoginScreen。
	// authLoadingAtom 默认 false，仅在此处回退兼容旧逻辑。
	return { isLoggedIn, authLoading };
}
