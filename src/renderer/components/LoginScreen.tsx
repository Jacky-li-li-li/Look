// ============================================================
// LoginScreen — email + password auth via Supabase
// Ink Wash design language
// ============================================================

import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import { cn } from "@shared/lib/utils";
import { useAtom } from "jotai";
import { Loader2, Mail, Lock, ArrowRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { supabase } from "../lib/supabase";
import { authLoadingAtom, isLoggedInAtom, userProfileAtom } from "../store/authAtoms";
import { PixelAgentAvatar } from "./PixelAgentAvatar";

const api = (window as any).look;

export default function LoginScreen() {
	const { t } = useTranslation();
	const [, setIsLoggedIn] = useAtom(isLoggedInAtom);
	const [, setAuthLoading] = useAtom(authLoadingAtom);
	const [, setUserProfile] = useAtom(userProfileAtom);

	const [mode, setMode] = useState<"login" | "register">("login");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);

		if (!email.trim()) {
			setError(t("auth.emailRequired", "Email is required"));
			return;
		}
		if (password.length < 6) {
			setError(t("auth.passwordMinLength", "Password must be at least 6 characters"));
			return;
		}

		setSubmitting(true);

		if (mode === "register") {
			const { data, error: signUpError } = await supabase.auth.signUp({
				email: email.trim(),
				password,
			});

			if (signUpError) {
				// Handle "already registered" gracefully
				if (signUpError.message?.includes("already registered") || signUpError.code === "user_already_exists") {
					setError(t("auth.alreadyRegistered", "This email is already registered. Please sign in instead."));
				} else {
					setError(signUpError.message);
				}
				setSubmitting(false);
				return;
			}

			if (data.user) {
				// Update local profile from cloud (triggered by DB trigger)
				await loadProfile(data.user.id, data.user.email ?? email);
			}

			toast.success(t("auth.registerSuccess", "Account created! You're now signed in."));
			setIsLoggedIn(true);
		} else {
			// login
			const { data, error: signInError } = await supabase.auth.signInWithPassword({
				email: email.trim(),
				password,
			});

			if (signInError) {
				setError(signInError.message);
				setSubmitting(false);
				return;
			}

			if (data.user) {
				await loadProfile(data.user.id, data.user.email ?? email);
			}

			setIsLoggedIn(true);
		}

		setSubmitting(false);
		setAuthLoading(false);
	}

	async function loadProfile(userId: string, userEmail: string) {
		// 1. Try fetching from Supabase
		const { data: cloudProfile } = await supabase
			.from("user_profiles")
			.select("user_name, avatar")
			.eq("id", userId)
			.single();

		if (cloudProfile) {
			setUserProfile({
				userId,
				email: userEmail,
				userName: cloudProfile.user_name || userEmail,
				avatar: cloudProfile.avatar || "",
			});
			// Persist to local ~/.look/user-profile.json for offline fallback
			if (api?.updateUserProfile) {
				api.updateUserProfile({
					userId,
					email: userEmail,
					userName: cloudProfile.user_name || userEmail,
					avatar: cloudProfile.avatar || "",
				}).catch(() => {});
			}
			return;
		}

		// 2. Fallback to local profile
		if (api?.getUserProfile) {
			const r = await api.getUserProfile().catch(() => null);
			if (r?.success && r.profile?.userId) {
				setUserProfile(r.profile);
				return;
			}
		}

		// 3. Bare default
		setUserProfile({ userId, email: userEmail, userName: userEmail, avatar: "" });
	}

	function switchMode() {
		setError(null);
		setMode(mode === "login" ? "register" : "login");
	}

	return (
		<div className="flex h-screen flex-col items-center justify-center bg-background p-6">
			<div className="w-full max-w-sm">
				{/* Logo */}
				<div className="mb-8 flex flex-col items-center gap-3">
					<PixelAgentAvatar size="lg" active />
					<h1 className="text-xl font-semibold tracking-tight text-foreground">Look</h1>
					<p className="text-xs text-muted-foreground">
						{mode === "login" ? t("auth.loginTitle", "Sign in to continue") : t("auth.registerTitle", "Create an account")}
					</p>
				</div>

				{/* Form */}
				<form onSubmit={handleSubmit} className="flex flex-col gap-4">
					<div className="relative">
						<Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							type="email"
							placeholder={t("auth.emailPlaceholder", "Email")}
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							className="h-11 pl-10 text-[13px]"
							autoFocus
							disabled={submitting}
						/>
					</div>

					<div className="relative">
						<Lock className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							type="password"
							placeholder={t("auth.passwordPlaceholder", "Password")}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							className="h-11 pl-10 text-[13px]"
							disabled={submitting}
						/>
					</div>

					{error && (
						<div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
							{error}
						</div>
					)}

					<Button
						type="submit"
						disabled={submitting}
						className={cn("h-11 w-full text-[13px] font-medium", submitting && "opacity-70")}
					>
						{submitting ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							<>
								{mode === "login" ? t("auth.loginBtn", "Sign In") : t("auth.registerBtn", "Create Account")}
								<ArrowRight className="ml-2 size-4" />
							</>
						)}
					</Button>
				</form>

				{/* Toggle mode */}
				<div className="mt-6 text-center">
					<button
						type="button"
						onClick={switchMode}
						disabled={submitting}
						className="text-[12px] text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
					>
						{mode === "login"
							? t("auth.switchToRegister", "Don't have an account? Sign up")
							: t("auth.switchToLogin", "Already have an account? Sign in")}
					</button>
				</div>
			</div>
		</div>
	);
}
