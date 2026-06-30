// ============================================================
// useAuthSession — Supabase 会话恢复 + 登录态管理
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
				setIsLoggedIn(true);
				setAuthLoading(false);
				return;
			}

			const {
				data: { session },
			} = await supabase.auth.getSession();

			if (session?.user) {
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
				setIsLoggedIn(true);
			} else {
				try {
					const r = await api.getUserProfile();
					if (r?.success && r.profile?.userId) {
						setUserProfile(r.profile);
						setIsLoggedIn(true);
						setAuthLoading(false);
						return;
					}
				} catch {}
				setIsLoggedIn(false);
			}
			setAuthLoading(false);
		}

		restoreSession();
	}, [setAuthLoading, setIsLoggedIn, setUserProfile]);

	return { isLoggedIn, authLoading };
}
