// ============================================================
// ProfileEditor — 名刺式身份卡：方形「印章」头像 + 字段表
// Used inside SettingsPage
//
// 设计意图：头像不用圆形模板，而是与 About 页应用图标同圆角率
// （22%）的方形印章；右侧是 hairline 分隔的字段行（微标签 +
// mono 数据），点击即可就地编辑。
// ============================================================

import { UserAvatar } from "@look/ui/components/UserAvatar";
import { Button } from "@look/ui/components/ui/button";
import { useAtom } from "jotai";
import { Camera, LogOut, Pencil } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { clearAuthCache, writeAuthCache } from "../../lib/authCache";
import { getSupabase, resetSupabaseClient } from "../../lib/supabase";
import { authLoadingAtom, isLoggedInAtom, userProfileAtom } from "../../store/authAtoms";

const api = window.look;

/** 字段行微标签（与 AboutTab 版本记录标题同一语言） */
const LABEL_CLASS = "text-[11px] font-medium uppercase tracking-widest text-muted-foreground/70";
/** 数据值（账号/邮箱）一律 mono，与 AboutTab 版本号、进度百分比一致 */
const MONO_VALUE_CLASS = "font-mono text-[13px] tabular-nums";

export default function ProfileEditor() {
	const { t } = useTranslation();
	const [profile, setProfile] = useAtom(userProfileAtom);
	const [, setIsLoggedIn] = useAtom(isLoggedInAtom);
	const [, setAuthLoading] = useAtom(authLoadingAtom);
	const [editingName, setEditingName] = useState(false);
	const [nameValue, setNameValue] = useState(profile.userName);
	const nameRef = useRef<HTMLInputElement>(null);

	async function handleLogout() {
		try {
			await api.logout();
		} catch {
			/* ignore */
		}
		try {
			const supabase = await getSupabase();
			if (supabase) await supabase.auth.signOut();
		} catch {
			/* ignore */
		}
		resetSupabaseClient();
		clearAuthCache();
		setProfile({
			userId: "",
			email: "",
			userName: "You",
			handle: "",
			avatar: "",
		});
		setIsLoggedIn(false);
		setAuthLoading(false);
		toast.success(t("auth.loggedOut"));
	}

	function persistProfile(patch: Partial<typeof profile>) {
		setProfile((prev) => {
			const next = { ...prev, ...patch };
			writeAuthCache(next);
			return next;
		});
		if (api?.updateUserProfile) {
			api.updateUserProfile(patch).catch((err) => console.warn("[ProfileEditor] updateUserProfile failed:", err));
		}
		// RLS enforces auth.uid() = id on user_profiles;
		// the id comes from supabase.auth.getUser() — server-verified identity
		getSupabase().then((supabase) => {
			if (!supabase) return;
			supabase.auth.getUser().then(({ data: authData }) => {
				if (!authData.user) return;
				supabase
					.from("user_profiles")
					.upsert({
						id: authData.user.id,
						email: "email" in patch ? patch.email : profile.email,
						user_name: "userName" in patch ? patch.userName : profile.userName,
						avatar: "avatar" in patch ? patch.avatar : profile.avatar,
					})
					.then(({ error }) => {
						if (!error) {
							if ("userName" in patch) toast.success(t("profile.userNameSaved"));
							if ("avatar" in patch) toast.success(t("profile.avatarSaved"));
						}
					});
			});
		});
	}

	function commitName() {
		const trimmed = nameValue.trim();
		if (trimmed && trimmed !== profile.userName) {
			persistProfile({ userName: trimmed });
		}
		setEditingName(false);
	}

	function handleAvatarUpload() {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			const reader = new FileReader();
			reader.onload = async () => {
				const dataUrl = reader.result as string;
				persistProfile({ avatar: dataUrl });
			};
			reader.readAsDataURL(file);
		};
		input.click();
	}

	return (
		<div className="flex items-stretch gap-5 rounded-xl border border-hairline p-5">
			{/* 印章：方形头像，hover 显示更换入口 */}
			<button
				type="button"
				onClick={handleAvatarUpload}
				className="group relative shrink-0 cursor-pointer self-start rounded-[22%] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				aria-label={t("profile.uploadAvatar")}
			>
				<UserAvatar avatar={profile.avatar} size="xl" className="rounded-[22%] [&_img]:rounded-[20%]" />
				<span className="absolute inset-0 flex items-center justify-center rounded-[22%] bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
					<Camera className="size-5 text-white" />
				</span>
			</button>

			{/* 字段表：hairline 分隔，点击就地编辑 */}
			<div className="min-w-0 flex-1 divide-y divide-hairline">
				{/* 用户名 */}
				<div className="group pb-3">
					<div className="flex items-center justify-between">
						<span className={LABEL_CLASS}>{t("profile.userName")}</span>
						{!editingName && (
							<Pencil className="size-3 text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100" />
						)}
					</div>
					{editingName ? (
						<input
							ref={nameRef}
							aria-label={t("profile.userName")}
							value={nameValue}
							onChange={(e) => setNameValue(e.target.value)}
							onBlur={commitName}
							onKeyDown={(e) => {
								if (e.key === "Enter") commitName();
								if (e.key === "Escape") {
									setEditingName(false);
									setNameValue(profile.userName);
								}
							}}
							className="mt-1 w-full border-b border-foreground bg-transparent pb-0.5 text-[15px] font-medium outline-none"
							maxLength={30}
							autoFocus
						/>
					) : (
						<button
							type="button"
							onClick={() => {
								setEditingName(true);
								setNameValue(profile.userName);
								setTimeout(() => nameRef.current?.focus(), 0);
							}}
							className="mt-1 block w-full pb-0.5 text-left text-[15px] font-medium outline-none"
						>
							{profile.userName || t("chat.you")}
						</button>
					)}
				</div>

				{/* 登录邮箱：只读身份凭据 */}
				<div className="py-3">
					<span className={LABEL_CLASS}>{t("profile.email")}</span>
					<p className={`mt-1 truncate pb-0.5 ${MONO_VALUE_CLASS}`} title={profile.email}>
						{profile.email || "—"}
					</p>
				</div>

				{/* 退出登录：安静的角落动作 */}
				<div className="flex justify-end pt-2.5">
					<Button
						type="button"
						variant="line"
						size="sm"
						onClick={handleLogout}
						className="text-muted-foreground hover:border-destructive/50 hover:text-destructive"
					>
						<LogOut />
						{t("auth.logout")}
					</Button>
				</div>
			</div>
		</div>
	);
}
