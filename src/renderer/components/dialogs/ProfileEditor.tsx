// ============================================================
// ProfileEditor — inline profile editing (avatar + username)
// Used inside SettingsDialog
// ============================================================

import { useAtom } from "jotai";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { supabase } from "../../lib/supabase";
import { userProfileAtom } from "../../store/authAtoms";
import UserAvatar from "../UserAvatar";

const api = window.look;

export default function ProfileEditor() {
	const { t } = useTranslation();
	const [profile, setProfile] = useAtom(userProfileAtom);
	const [editingName, setEditingName] = useState(false);
	const [nameValue, setNameValue] = useState(profile.userName);
	const nameRef = useRef<HTMLInputElement>(null);

	async function commitName() {
		const trimmed = nameValue.trim();
		if (trimmed && trimmed !== profile.userName) {
			setProfile((prev) => ({ ...prev, userName: trimmed }));
			if (api?.updateUserProfile) {
				api.updateUserProfile({ userName: trimmed }).catch(() => {});
			}
			// RLS enforces auth.uid() = id on user_profiles;
			// the id comes from supabase.auth.getUser() — server-verified identity
			const { data: authData } = await supabase.auth.getUser();
			if (authData.user) {
				supabase
					.from("user_profiles")
					.upsert({
						id: authData.user.id,
						email: profile.email,
						user_name: trimmed,
						avatar: profile.avatar,
					})
					.then(({ error }) => {
						if (!error) toast.success(t("profile.userNameSaved"));
					});
			}
		}
		setEditingName(false);
	}

	async function handleAvatarUpload() {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			const reader = new FileReader();
			reader.onload = async () => {
				const dataUrl = reader.result as string;
				setProfile((prev) => ({ ...prev, avatar: dataUrl }));
				if (api?.updateUserProfile) {
					api.updateUserProfile({ avatar: dataUrl }).catch(() => {});
				}
				// RLS enforces auth.uid() = id on user_profiles;
				// the id comes from supabase.auth.getUser() — server-verified identity
				const { data: authData } = await supabase.auth.getUser();
				if (authData.user) {
					supabase
						.from("user_profiles")
						.upsert({
							id: authData.user.id,
							email: profile.email,
							user_name: profile.userName,
							avatar: dataUrl,
						})
						.then(({ error }) => {
							if (!error) toast.success(t("profile.avatarSaved"));
						});
				}
			};
			reader.readAsDataURL(file);
		};
		input.click();
	}

	return (
		<>
			<div className="flex items-center justify-between gap-4 py-3">
				<div className="flex min-w-0 flex-col gap-0.5">
					<label className="text-[13px] font-medium leading-none">{t("profile.avatar")}</label>
					<span className="text-[11px] text-muted-foreground leading-tight">{t("profile.chooseEmoji")}</span>
				</div>
				<button type="button" onClick={handleAvatarUpload} className="transition-opacity hover:opacity-80">
					<UserAvatar avatar={profile.avatar} size="lg" />
				</button>
			</div>
			<div className="flex items-center justify-between gap-4 py-3">
				<div className="flex min-w-0 flex-col gap-0.5">
					<label className="text-[13px] font-medium leading-none">{t("profile.userName")}</label>
					<span className="text-[11px] text-muted-foreground leading-tight">
						{t("profile.userNamePlaceholder")}
					</span>
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
						className="h-8 w-36 rounded-md border border-border bg-transparent px-2 text-[13px] outline-none focus:border-foreground"
						maxLength={30}
					/>
				) : (
					<button
						type="button"
						onClick={() => {
							setEditingName(true);
							setNameValue(profile.userName);
							setTimeout(() => nameRef.current?.focus(), 0);
						}}
						className="text-[13px] font-medium underline-offset-2 hover:underline"
					>
						{profile.userName || t("chat.you")}
					</button>
				)}
			</div>
		</>
	);
}
