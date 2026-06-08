// ============================================================
// LoginScreen — email + password via Supabase
// Ink Wash design language
// ============================================================

import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import { cn } from "@shared/lib/utils";
import { useAtom } from "jotai";
import { ArrowRight, Loader2, Lock, Mail } from "lucide-react";
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

	const [mode, setMode] = useState<"login" | "register" | "forgot">("login");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState(false);

	function reset() {
		setError(null);
		setPassword("");
		setSent(false);
	}

	// ── Login ──

	async function handleLogin(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!email.trim()) { setError(t("auth.emailRequired")); return; }
		if (password.length < 6) { setError(t("auth.passwordMinLength")); return; }

		setSubmitting(true);
		const { data, error: err } = await supabase.auth.signInWithPassword({
			email: email.trim(), password,
		});
		if (err) { setError(err.message); setSubmitting(false); return; }
		if (data.user) {
			await loadProfile(data.user.id, data.user.email ?? email);
			setIsLoggedIn(true); setAuthLoading(false);
		}
	}

	// ── Register ──

	async function handleRegister(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!email.trim()) { setError(t("auth.emailRequired")); return; }
		if (password.length < 6) { setError(t("auth.passwordMinLength")); return; }

		setSubmitting(true);
		const { error: err } = await supabase.auth.signUp({
			email: email.trim(), password,
		});
		setSubmitting(false);

		if (err) {
			if (err.message?.includes("already registered") || err.code === "user_already_exists") {
				setError(t("auth.alreadyRegistered"));
			} else {
				setError(err.message);
			}
			return;
		}

		setSent(true);
		toast.success(t("auth.checkEmailToConfirm"));
	}

	// ── Forgot password ──

	async function handleForgot(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!email.trim()) { setError(t("auth.emailRequired")); return; }

		setSubmitting(true);
		const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim());
		setSubmitting(false);

		if (err) { setError(err.message); return; }
		setSent(true);
		toast.success(t("auth.passwordResetEmailSent"));
	}

	// ── Profile ──

	async function loadProfile(userId: string, userEmail: string) {
		const { data: p } = await supabase.from("user_profiles")
			.select("user_name, avatar").eq("id", userId).single();

		const profile = {
			userId, email: userEmail,
			userName: p?.user_name || userEmail.split("@")[0],
			avatar: p?.avatar || "",
		};
		setUserProfile(profile);
		if (api?.updateUserProfile) api.updateUserProfile(profile).catch(() => {});
	}

	return (
		<div className="flex h-screen flex-col items-center justify-center bg-background p-6">
			<div className="w-full max-w-sm">
				<div className="mb-8 flex flex-col items-center gap-3">
					<PixelAgentAvatar size="lg" active />
					<h1 className="text-xl font-semibold tracking-tight text-foreground">Look</h1>
					<p className="text-xs text-muted-foreground">
						{mode === "login" && t("auth.loginDesc")}
						{mode === "register" && t("auth.registerDesc")}
						{mode === "forgot" && t("auth.forgotDesc")}
					</p>
				</div>

				{/* ── Login ── */}
				{mode === "login" && (
					<form onSubmit={handleLogin} className="flex flex-col gap-4">
						<div className="relative">
							<Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input type="email" placeholder={t("auth.emailPlaceholder")} value={email}
								onChange={(e) => setEmail(e.target.value)}
								className="h-11 pl-10 text-[13px]" autoFocus disabled={submitting} />
						</div>
						<div className="relative">
							<Lock className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input type="password" placeholder={t("auth.passwordPlaceholder")} value={password}
								onChange={(e) => setPassword(e.target.value)}
								className="h-11 pl-10 text-[13px]" disabled={submitting} />
						</div>
						{error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{error}</div>}
						<Button type="submit" disabled={submitting}
							className={cn("h-11 w-full text-[13px] font-medium", submitting && "opacity-70")}>
							{submitting ? <Loader2 className="size-4 animate-spin" /> : <>{t("auth.loginBtn")}<ArrowRight className="ml-2 size-4" /></>}
						</Button>
						<div className="flex justify-between text-[12px]">
							<button type="button" onClick={() => { setMode("forgot"); reset(); }}
								className="text-muted-foreground underline-offset-2 hover:underline">
								{t("auth.forgotPassword")}
							</button>
						</div>
						<div className="text-center">
							<button type="button" onClick={() => { setMode("register"); reset(); }}
								className="text-[12px] text-muted-foreground underline-offset-2 hover:underline">
								{t("auth.switchToRegister")}
							</button>
						</div>
					</form>
				)}

				{/* ── Register ── */}
				{mode === "register" && !sent && (
					<form onSubmit={handleRegister} className="flex flex-col gap-4">
						<div className="relative">
							<Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input type="email" placeholder={t("auth.emailPlaceholder")} value={email}
								onChange={(e) => setEmail(e.target.value)}
								className="h-11 pl-10 text-[13px]" autoFocus disabled={submitting} />
						</div>
						<div className="relative">
							<Lock className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input type="password" placeholder={t("auth.setYourPassword")} value={password}
								onChange={(e) => setPassword(e.target.value)}
								className="h-11 pl-10 text-[13px]" disabled={submitting} />
						</div>
						{error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{error}</div>}
						<Button type="submit" disabled={submitting}
							className={cn("h-11 w-full text-[13px] font-medium", submitting && "opacity-70")}>
							{submitting ? <Loader2 className="size-4 animate-spin" /> : <>{t("auth.registerBtn")}<ArrowRight className="ml-2 size-4" /></>}
						</Button>
						<div className="text-center">
							<button type="button" onClick={() => { setMode("login"); reset(); }}
								className="text-[12px] text-muted-foreground underline-offset-2 hover:underline">
								{t("auth.switchToLogin")}
							</button>
						</div>
					</form>
				)}

				{/* ── Register success ── */}
				{mode === "register" && sent && (
					<div className="flex flex-col gap-4">
						<div className="rounded-lg border border-hairline bg-muted/30 px-4 py-6 text-center">
							<p className="text-[13px] font-medium text-foreground">{t("auth.checkEmailTitle")}</p>
							<p className="mt-2 text-[12px] text-muted-foreground">
								{t("auth.checkEmailDesc", "We sent a confirmation link to")}{" "}
								<span className="font-medium text-foreground">{email}</span>
							</p>
						</div>
						<Button variant="outline" className="h-10 w-full text-[12px]"
							onClick={() => { setMode("login"); reset(); }}>
							{t("auth.backToLogin")}
						</Button>
					</div>
				)}

				{/* ── Forgot password ── */}
				{mode === "forgot" && !sent && (
					<form onSubmit={handleForgot} className="flex flex-col gap-4">
						<div className="relative">
							<Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input type="email" placeholder={t("auth.emailPlaceholder")} value={email}
								onChange={(e) => setEmail(e.target.value)}
								className="h-11 pl-10 text-[13px]" autoFocus disabled={submitting} />
						</div>
						{error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{error}</div>}
						<Button type="submit" disabled={submitting}
							className={cn("h-11 w-full text-[13px] font-medium", submitting && "opacity-70")}>
							{submitting ? <Loader2 className="size-4 animate-spin" /> : <>{t("auth.sendResetLink")}<ArrowRight className="ml-2 size-4" /></>}
						</Button>
						<div className="text-center">
							<button type="button" onClick={() => { setMode("login"); reset(); }}
								className="text-[12px] text-muted-foreground underline-offset-2 hover:underline">
								{t("auth.backToLogin")}
							</button>
						</div>
					</form>
				)}

				{/* ── Forgot sent ── */}
				{mode === "forgot" && sent && (
					<div className="flex flex-col gap-4">
						<div className="rounded-lg border border-hairline bg-muted/30 px-4 py-6 text-center">
							<p className="text-[13px] font-medium text-foreground">{t("auth.resetEmailSent")}</p>
							<p className="mt-2 text-[12px] text-muted-foreground">
								{t("auth.checkEmailDesc", "We sent a reset link to")}{" "}
								<span className="font-medium text-foreground">{email}</span>
							</p>
						</div>
						<Button variant="outline" className="h-10 w-full text-[12px]"
							onClick={() => { setMode("login"); reset(); }}>
							{t("auth.backToLogin")}
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}
