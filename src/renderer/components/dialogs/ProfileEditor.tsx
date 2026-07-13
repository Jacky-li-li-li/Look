// ============================================================
// ProfileEditor — inline profile editing (avatar + username)
// Used inside SettingsDialog
// ============================================================

import { UserAvatar } from "@shared/components/UserAvatar";
import { useAtom } from "jotai";
import { Camera } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { getSupabase } from "../../lib/supabase";
import { userProfileAtom } from "../../store/authAtoms";

const api = window.look;

function deriveHandle(profile: { handle?: string; email: string; userName: string }): string {
	if (profile.handle?.trim()) return profile.handle.trim();
	if (profile.email) {
		const prefix = profile.email.split("@")[0];
		if (prefix) return prefix;
	}
	return profile.userName || "you";
}

export default function ProfileEditor() {
	const { t } = useTranslation();
	const [profile, setProfile] = useAtom(userProfileAtom);
	const [editingName, setEditingName] = useState(false);
	const [nameValue, setNameValue] = useState(profile.userName);
	const [editingHandle, setEditingHandle] = useState(false);
	const [handleValue, setHandleValue] = useState(deriveHandle(profile));
	const nameRef = useRef<HTMLInputElement>(null);
	const handleRef = useRef<HTMLInputElement>(null);

	function persistProfile(patch: Partial<typeof profile>) {
		setProfile((prev) => ({ ...prev, ...patch }));
		if (api?.updateUserProfile) {
			api.updateUserProfile(patch).catch(() => {});
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

	function commitHandle() {
		const trimmed = handleValue.trim().replace(/^@/, "");
		if (trimmed !== (profile.handle ?? "")) {
			persistProfile({ handle: trimmed });
		}
		setEditingHandle(false);
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

	const displayHandle = deriveHandle(profile);

	return (
		<div className="flex flex-col items-center py-6">
			{/* Avatar */}
			<button
				type="button"
				onClick={handleAvatarUpload}
				className="group relative mb-4 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				aria-label={t("profile.uploadAvatar")}
			>
				<UserAvatar avatar={profile.avatar} size="xl" circular />
				<span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
					<Camera className="size-6 text-white" />
				</span>
			</button>

			{/* Display name */}
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
					className="mb-1 h-9 w-48 rounded-md border border-border bg-transparent px-2 text-center text-xl font-semibold outline-none focus:border-foreground"
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
					className="mb-1 text-xl font-semibold hover:opacity-80"
				>
					{profile.userName || t("chat.you")}
				</button>
			)}

			{/* Handle + role badge */}
			{editingHandle ? (
				<div className="flex items-center gap-2">
					<span className="text-sm text-muted-foreground">@</span>
					<input
						ref={handleRef}
						aria-label={t("profile.handle")}
						value={handleValue}
						onChange={(e) => setHandleValue(e.target.value.replace(/^@/, ""))}
						onBlur={commitHandle}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitHandle();
							if (e.key === "Escape") {
								setEditingHandle(false);
								setHandleValue(deriveHandle(profile));
							}
						}}
						className="h-7 w-32 rounded-md border border-border bg-transparent px-2 text-center text-[13px] outline-none focus:border-foreground"
						maxLength={30}
						autoFocus
					/>
				</div>
			) : (
				<button
					type="button"
					onClick={() => {
						setEditingHandle(true);
						setHandleValue(deriveHandle(profile));
						setTimeout(() => handleRef.current?.focus(), 0);
					}}
					className="flex items-center gap-2 text-sm text-muted-foreground hover:opacity-80"
				>
					<span>@{displayHandle}</span>
				</button>
			)}
		</div>
	);
}
