// ============================================================
// LoginScreen — email OTP + password via Supabase
// Ink Wash design language
// ============================================================

import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import { cn } from "@shared/lib/utils";
import { useAtom } from "jotai";
import { ArrowRight, Hash, Loader2, Lock, Mail } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { supabase } from "../lib/supabase";
import { authLoadingAtom, isLoggedInAtom, userProfileAtom } from "../store/authAtoms";
import { PixelAgentAvatar } from "./PixelAgentAvatar";

const api = (window as any).look;

type Purpose = "login" | "register" | "forgot";
type Step = "credentials" | "otp" | "set-password";

export default function LoginScreen() {
	const { t } = useTranslation();
	const [, setIsLoggedIn] = useAtom(isLoggedInAtom);
	const [, setAuthLoading] = useAtom(authLoadingAtom);
	const [, setUserProfile] = useAtom(userProfileAtom);

	const [purpose, setPurpose] = useState<Purpose>("login");
	const [step, setStep] = useState<Step>("credentials");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function reset(backToLogin = true) {
		setStep("credentials");
		setCode("");
		setPassword("");
		setError(null);
		if (backToLogin) setPurpose("login");
	}

	// ── Password login ──────────────────────────────────────

	async function handlePasswordLogin(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!email.trim()) { setError(t("auth.emailRequired")); return; }
		if (password.length < 6) { setError(t("auth.passwordMinLength")); return; }

		setSubmitting(true);
		const { data, error: err } = await supabase.auth.signInWithPassword({
			email: email.trim(),
			password,
		});
		if (err) { setError(err.message); setSubmitting(false); return; }
		if (data.user) {
			await loadProfile(data.user.id, data.user.email ?? email);
			setIsLoggedIn(true);
			setAuthLoading(false);
		}
	}

	// ── Send OTP (shared by register / forgot / alternative login) ──

	async function handleSendOtp(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!email.trim()) { setError(t("auth.emailRequired")); return; }

		setSubmitting(true);
		const { error: err } = await supabase.auth.signInWithOtp({
			email: email.trim(),
			options: {
				shouldCreateUser: purpose === "register",
			},
		});
		setSubmitting(false);
		if (err) { setError(err.message); return; }

		setStep("otp");
		toast(t("auth.codeSent"));
	}

	// ── Verify OTP ──────────────────────────────────────────

	async function handleVerifyOtp(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (code.length < 6) { setError(t("auth.codeMinLength")); return; }

		setSubmitting(true);
		const { data, error: err } = await supabase.auth.verifyOtp({
			email: email.trim(),
			token: code.trim(),
			type: "email",
		});
		if (err || !data.user) {
			setError(err?.message ?? t("auth.verifyFailed"));
			setSubmitting(false);
			return;
		}

		// register / forgot → prompt to set password
		if (purpose === "register" || purpose === "forgot") {
			setStep("set-password");
			setSubmitting(false);
			return;
		}

		// login via OTP → done
		await loadProfile(data.user.id, data.user.email ?? email);
		setIsLoggedIn(true);
		setAuthLoading(false);
	}

	// ── Set password (after OTP verification) ───────────────

	async function handleSetPassword(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (password.length < 6) { setError(t("auth.passwordMinLength")); return; }

		setSubmitting(true);
		const { error: err } = await supabase.auth.updateUser({ password });

		if (err) { setError(err.message); setSubmitting(false); return; }

		if (purpose === "forgot") {
			toast.success(t("auth.passwordResetSuccess"));
			reset(true);
			setSubmitting(false);
			return;
		}

		// register: password set → load profile and enter
		const { data: { user } } = await supabase.auth.getUser();
		if (user) {
			// Update cloud profile with email-based default name
			const defaultName = email.trim().split("@")[0];
			await supabase.from("user_profiles").upsert({
				id: user.id,
				email: user.email ?? email,
				user_name: defaultName,
				avatar: "",
			});
			await loadProfile(user.id, user.email ?? email);
		}
		setIsLoggedIn(true);
		setAuthLoading(false);
	}

	// ── Resend OTP ──────────────────────────────────────────

	async function handleResend() {
		setError(null);
		setSubmitting(true);
		const { error: err } = await supabase.auth.signInWithOtp({
			email: email.trim(),
			options: { shouldCreateUser: purpose === "register" },
		});
		setSubmitting(false);
		if (err) { setError(err.message); return; }
		toast(t("auth.codeResent"));
	}

	// ── Profile loading ─────────────────────────────────────

	async function loadProfile(userId: string, userEmail: string) {
		const { data: p } = await supabase.from("user_profiles")
			.select("user_name, avatar").eq("id", userId).single();

		if (p) {
			setUserProfile({ userId, email: userEmail, userName: p.user_name || userEmail.split("@")[0], avatar: p.avatar || "" });
		} else {
			setUserProfile({ userId, email: userEmail, userName: userEmail.split("@")[0], avatar: "" });
		}
		// Persist locally
		if (api?.updateUserProfile) {
			const up = p;
			api.updateUserProfile({
				userId, email: userEmail,
				userName: up?.user_name || userEmail.split("@")[0],
				avatar: up?.avatar || "",
			}).catch(() => {});
		}
	}

	// ── Description text ────────────────────────────────────

	const descText = () => {
		if (purpose === "forgot") {
			if (step === "credentials") return t("auth.forgotDesc");
			if (step === "otp") return t("auth.enterCode");
			return t("auth.setNewPassword");
		}
		if (purpose === "register") {
			if (step === "credentials") return t("auth.registerDesc");
			if (step === "otp") return t("auth.enterCode");
			return t("auth.setPasswordForNewAccount");
		}
		// login
		if (step === "credentials") return t("auth.loginDesc");
		return t("auth.enterCode");
	};

	// ── Render ──────────────────────────────────────────────

	return (
		<div className="flex h-screen flex-col items-center justify-center bg-background p-6">
			<div className="w-full max-w-sm">
				<div className="mb-8 flex flex-col items-center gap-3">
					<PixelAgentAvatar size="lg" active />
					<h1 className="text-xl font-semibold tracking-tight text-foreground">Look</h1>
					<p className="text-xs text-muted-foreground">{descText()}</p>
				</div>

				{/* ── Password login ── */}
				{purpose === "login" && step === "credentials" && (
					<form onSubmit={handlePasswordLogin} className="flex flex-col gap-4">
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
							<button type="button" onClick={() => { setPurpose("forgot"); setError(null); }}
								className="text-muted-foreground underline-offset-2 hover:underline">
								{t("auth.forgotPassword")}
							</button>
							<button type="button" onClick={() => { setStep("otp"); setError(null); }}
								className="text-muted-foreground underline-offset-2 hover:underline">
								{t("auth.useCodeInstead")}
							</button>
						</div>
						<div className="text-center">
							<button type="button" onClick={() => { setPurpose("register"); setError(null); setPassword(""); }}
								className="text-[12px] text-muted-foreground underline-offset-2 hover:underline">
								{t("auth.switchToRegister")}
							</button>
						</div>
					</form>
				)}

				{/* ── Send OTP (register / forgot / login-via-code) ── */}
				{step === "credentials" && purpose !== "login" && (
					<form onSubmit={handleSendOtp} className="flex flex-col gap-4">
						<div className="relative">
							<Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input type="email" placeholder={t("auth.emailPlaceholder")} value={email}
								onChange={(e) => setEmail(e.target.value)}
								className="h-11 pl-10 text-[13px]" autoFocus disabled={submitting} />
						</div>
						{error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{error}</div>}
						<Button type="submit" disabled={submitting}
							className={cn("h-11 w-full text-[13px] font-medium", submitting && "opacity-70")}>
							{submitting ? <Loader2 className="size-4 animate-spin" /> : <>{t("auth.sendCode")}<ArrowRight className="ml-2 size-4" /></>}
						</Button>
						<div className="text-center">
							<button type="button" onClick={() => reset(true)}
								className="text-[12px] text-muted-foreground underline-offset-2 hover:underline">
								{t("common.cancel")}
							</button>
						</div>
					</form>
				)}

				{/* ── Verify OTP (login via code) ── */}
				{purpose === "login" && step === "otp" && (
					<form onSubmit={handleVerifyOtp} className="flex flex-col gap-4">
						<div className="rounded-lg border border-hairline bg-muted/30 px-3 py-2 text-center text-[12px] text-muted-foreground">
							{t("auth.codeSentTo")} <span className="font-medium text-foreground">{email}</span>
						</div>
						<div className="relative">
							<Hash className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input type="text" inputMode="numeric" maxLength={6} placeholder="000000" value={code}
								onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
								className="h-11 pl-10 text-center text-[18px] tracking-[0.3em]" autoFocus disabled={submitting} />
						</div>
						{error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{error}</div>}
						<Button type="submit" disabled={submitting || code.length < 6}
							className={cn("h-11 w-full text-[13px] font-medium", submitting && "opacity-70")}>
							{submitting ? <Loader2 className="size-4 animate-spin" /> : <>{t("auth.verifyBtn")}<ArrowRight className="ml-2 size-4" /></>}
						</Button>
						<div className="flex justify-center gap-4 text-[12px]">
							<button type="button" onClick={() => reset(true)} className="text-muted-foreground underline-offset-2 hover:underline">{t("auth.changeEmail")}</button>
							<button type="button" onClick={handleResend} className="text-muted-foreground underline-offset-2 hover:underline">{t("auth.resendCode")}</button>
						</div>
					</form>
				)}

				{/* ── OTP: verify code (register / forgot) ── */}
				{(purpose === "register" || purpose === "forgot") && step === "otp" && (
					<form onSubmit={handleVerifyOtp} className="flex flex-col gap-4">
						<div className="rounded-lg border border-hairline bg-muted/30 px-3 py-2 text-center text-[12px] text-muted-foreground">
							{t("auth.codeSentTo")} <span className="font-medium text-foreground">{email}</span>
						</div>
						<div className="relative">
							<Hash className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input type="text" inputMode="numeric" maxLength={6} placeholder="000000" value={code}
								onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
								className="h-11 pl-10 text-center text-[18px] tracking-[0.3em]" autoFocus disabled={submitting} />
						</div>
						{error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{error}</div>}
						<Button type="submit" disabled={submitting || code.length < 6}
							className={cn("h-11 w-full text-[13px] font-medium", submitting && "opacity-70")}>
							{submitting ? <Loader2 className="size-4 animate-spin" /> : <>{t("auth.verifyBtn")}<ArrowRight className="ml-2 size-4" /></>}
						</Button>
						<div className="flex justify-center gap-4 text-[12px]">
							<button type="button" onClick={() => reset(true)} className="text-muted-foreground underline-offset-2 hover:underline">{t("auth.changeEmail")}</button>
							<button type="button" onClick={handleResend} className="text-muted-foreground underline-offset-2 hover:underline">{t("auth.resendCode")}</button>
						</div>
					</form>
				)}

				{/* ── Set password (register / forgot) ── */}
				{step === "set-password" && (
					<form onSubmit={handleSetPassword} className="flex flex-col gap-4">
						<div className="rounded-lg border border-hairline bg-muted/30 px-3 py-2 text-center text-[12px] text-muted-foreground">
							<span className="font-medium text-foreground">{email}</span>
						</div>
						<div className="relative">
							<Lock className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input type="password" placeholder={
								purpose === "forgot" ? t("auth.newPasswordPlaceholder") : t("auth.setYourPassword")
							} value={password}
								onChange={(e) => setPassword(e.target.value)}
								className="h-11 pl-10 text-[13px]" autoFocus disabled={submitting} />
						</div>
						{error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{error}</div>}
						<Button type="submit" disabled={submitting || password.length < 6}
							className={cn("h-11 w-full text-[13px] font-medium", submitting && "opacity-70")}>
							{submitting ? <Loader2 className="size-4 animate-spin" /> : <>
								{purpose === "forgot" ? t("auth.resetPasswordBtn") : t("auth.completeRegistration")}
								<ArrowRight className="ml-2 size-4" />
							</>}
						</Button>
						<div className="text-center">
							<button type="button" onClick={() => reset(true)}
								className="text-[12px] text-muted-foreground underline-offset-2 hover:underline">
								{t("common.cancel")}
							</button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}
