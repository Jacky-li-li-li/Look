// ============================================================
// LoginScreen — email + password via Supabase
// Ink Wash design language
// ============================================================

import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import { Switch } from "@shared/components/ui/switch";
import { cn } from "@shared/lib/utils";
import { useAtom } from "jotai";
import { ArrowRight, Loader2, Lock, Mail } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { writeAuthCache } from "../lib/authCache";
import { getSupabase, resetSupabaseClient } from "../lib/supabase";
import { authLoadingAtom, isLoggedInAtom, userProfileAtom } from "../store/authAtoms";
import { PixelAgentAvatar } from "./PixelAgentAvatar";

const api = window.look;

interface LoginState {
	mode: "login" | "register" | "forgot";
	email: string;
	password: string;
	rememberMe: boolean;
	submitting: boolean;
	error: string | null;
	sent: boolean;
}

const INITIAL_LOGIN_STATE: LoginState = {
	mode: "login",
	email: "",
	password: "",
	rememberMe: true,
	submitting: false,
	error: null,
	sent: false,
};

// ── Sub-components ──

function LoginForm({
	email,
	setEmail,
	password,
	setPassword,
	submitting,
	error,
	rememberMe,
	setRememberMe,
	handleLogin,
	onSwitchToForgot,
	onSwitchToRegister,
}: {
	email: string;
	setEmail: (v: string) => void;
	password: string;
	setPassword: (v: string) => void;
	submitting: boolean;
	error: string | null;
	rememberMe: boolean;
	setRememberMe: (v: boolean) => void;
	handleLogin: (e: React.FormEvent) => Promise<void>;
	onSwitchToForgot: () => void;
	onSwitchToRegister: () => void;
}) {
	const { t } = useTranslation();
	return (
		<form onSubmit={handleLogin} className="flex flex-col gap-4">
			<div className="relative">
				<Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input
					type="email"
					placeholder={t("auth.emailPlaceholder")}
					aria-label={t("auth.email", "Email")}
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
					placeholder={t("auth.passwordPlaceholder")}
					aria-label={t("auth.password", "Password")}
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
			<div className="flex items-center justify-between">
				<label
					htmlFor="rememberMe"
					className="flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground"
				>
					<Switch
						id="rememberMe"
						size="sm"
						checked={rememberMe}
						onCheckedChange={setRememberMe}
						disabled={submitting}
					/>
					{t("auth.rememberMe", "Remember me")}
				</label>
			</div>
			<Button
				type="submit"
				disabled={submitting}
				className={cn("h-11 w-full text-[13px] font-medium", submitting && "opacity-70")}
			>
				{submitting ? (
					<Loader2 className="size-4 animate-spin" />
				) : (
					<>
						{t("auth.loginBtn")}
						<ArrowRight className="ml-2 size-4" />
					</>
				)}
			</Button>
			<div className="flex justify-between text-[12px]">
				<button
					type="button"
					onClick={onSwitchToForgot}
					className="text-muted-foreground underline-offset-2 hover:underline"
				>
					{t("auth.forgotPassword")}
				</button>
				<button
					type="button"
					onClick={onSwitchToRegister}
					className="text-muted-foreground underline-offset-2 hover:underline"
				>
					{t("auth.switchToRegister")}
				</button>
			</div>
		</form>
	);
}

function RegisterForm({
	email,
	setEmail,
	password,
	setPassword,
	submitting,
	error,
	handleRegister,
	onSwitchToLogin,
}: {
	email: string;
	setEmail: (v: string) => void;
	password: string;
	setPassword: (v: string) => void;
	submitting: boolean;
	error: string | null;
	handleRegister: (e: React.FormEvent) => Promise<void>;
	onSwitchToLogin: () => void;
}) {
	const { t } = useTranslation();
	return (
		<form onSubmit={handleRegister} className="flex flex-col gap-4">
			<div className="relative">
				<Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input
					type="email"
					placeholder={t("auth.emailPlaceholder")}
					aria-label={t("auth.email", "Email")}
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
					placeholder={t("auth.setYourPassword")}
					aria-label={t("auth.password", "Password")}
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
						{t("auth.registerBtn")}
						<ArrowRight className="ml-2 size-4" />
					</>
				)}
			</Button>
			<div className="text-center">
				<button
					type="button"
					onClick={onSwitchToLogin}
					className="text-[12px] text-muted-foreground underline-offset-2 hover:underline"
				>
					{t("auth.switchToLogin")}
				</button>
			</div>
		</form>
	);
}

function RegisterSent({ email, onBackToLogin }: { email: string; onBackToLogin: () => void }) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-col gap-4">
			<div className="rounded-lg border border-hairline bg-muted/30 px-4 py-6 text-center">
				<p className="text-[13px] font-medium text-foreground">{t("auth.checkEmailTitle")}</p>
				<p className="mt-2 text-[12px] text-muted-foreground">
					{t("auth.checkEmailDesc", "We sent a confirmation link to")}{" "}
					<span className="font-medium text-foreground">{email}</span>
				</p>
			</div>
			<Button variant="outline" className="h-10 w-full text-[12px]" onClick={onBackToLogin}>
				{t("auth.backToLogin")}
			</Button>
		</div>
	);
}

function ForgotForm({
	email,
	setEmail,
	submitting,
	error,
	handleForgot,
	onBackToLogin,
}: {
	email: string;
	setEmail: (v: string) => void;
	submitting: boolean;
	error: string | null;
	handleForgot: (e: React.FormEvent) => Promise<void>;
	onBackToLogin: () => void;
}) {
	const { t } = useTranslation();
	return (
		<form onSubmit={handleForgot} className="flex flex-col gap-4">
			<div className="relative">
				<Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input
					type="email"
					placeholder={t("auth.emailPlaceholder")}
					aria-label={t("auth.email", "Email")}
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					className="h-11 pl-10 text-[13px]"
					autoFocus
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
						{t("auth.sendResetLink")}
						<ArrowRight className="ml-2 size-4" />
					</>
				)}
			</Button>
			<div className="text-center">
				<button
					type="button"
					onClick={onBackToLogin}
					className="text-[12px] text-muted-foreground underline-offset-2 hover:underline"
				>
					{t("auth.backToLogin")}
				</button>
			</div>
		</form>
	);
}

function ForgotSent({ email, onBackToLogin }: { email: string; onBackToLogin: () => void }) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-col gap-4">
			<div className="rounded-lg border border-hairline bg-muted/30 px-4 py-6 text-center">
				<p className="text-[13px] font-medium text-foreground">{t("auth.resetEmailSent")}</p>
				<p className="mt-2 text-[12px] text-muted-foreground">
					{t("auth.checkEmailDesc", "We sent a reset link to")}{" "}
					<span className="font-medium text-foreground">{email}</span>
				</p>
			</div>
			<Button variant="outline" className="h-10 w-full text-[12px]" onClick={onBackToLogin}>
				{t("auth.backToLogin")}
			</Button>
		</div>
	);
}

// ── Main component ──

export default function LoginScreen() {
	const { t } = useTranslation();
	const [, setIsLoggedIn] = useAtom(isLoggedInAtom);
	const [, setAuthLoading] = useAtom(authLoadingAtom);
	const [, setUserProfile] = useAtom(userProfileAtom);

	const [state, setState] = useState(INITIAL_LOGIN_STATE);
	const { mode, email, password, rememberMe, submitting, error, sent } = state;

	const setMode = useCallback((next: LoginState["mode"]) => setState((prev) => ({ ...prev, mode: next })), []);
	const setEmail = useCallback((next: string) => setState((prev) => ({ ...prev, email: next })), []);
	const setPassword = useCallback((next: string) => setState((prev) => ({ ...prev, password: next })), []);
	const setRememberMe = useCallback((next: boolean) => setState((prev) => ({ ...prev, rememberMe: next })), []);
	const setSubmitting = useCallback((next: boolean) => setState((prev) => ({ ...prev, submitting: next })), []);
	const setError = useCallback((next: string | null) => setState((prev) => ({ ...prev, error: next })), []);
	const setSent = useCallback((next: boolean) => setState((prev) => ({ ...prev, sent: next })), []);

	function reset() {
		setState((prev) => ({ ...prev, error: null, password: "", sent: false }));
	}

	// ── Login ──

	async function handleLogin(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!email.trim()) {
			setError(t("auth.emailRequired"));
			return;
		}
		if (password.length < 6) {
			setError(t("auth.passwordMinLength"));
			return;
		}

		setSubmitting(true);
		// Apply remember-me preference before creating the Supabase client so the
		// sign-in session is persisted (or not) according to the user's choice.
		if (!rememberMe) {
			try {
				localStorage.setItem("look_remember_me", "0");
			} catch {}
		} else {
			try {
				localStorage.removeItem("look_remember_me");
			} catch {}
		}
		resetSupabaseClient();
		const supabase = await getSupabase();
		if (!supabase) {
			setError(t("auth.unavailable"));
			setSubmitting(false);
			return;
		}
		const { data, error: err } = await supabase.auth.signInWithPassword({
			email: email.trim(),
			password,
			options: { captchaToken: undefined },
		});
		if (err) {
			setError(err.message);
			setSubmitting(false);
			return;
		}
		if (data.user) {
			const profile = await loadProfile(data.user.id, data.user.email ?? email);
			if (profile) writeAuthCache(profile);
			setIsLoggedIn(true);
			setAuthLoading(false);
		}
	}

	// ── Register ──

	async function handleRegister(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!email.trim()) {
			setError(t("auth.emailRequired"));
			return;
		}
		if (password.length < 6) {
			setError(t("auth.passwordMinLength"));
			return;
		}

		setSubmitting(true);
		const supabase = await getSupabase();
		if (!supabase) {
			setError(t("auth.unavailable"));
			setSubmitting(false);
			return;
		}
		const { error: err } = await supabase.auth.signUp({
			email: email.trim(),
			password,
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
		if (!email.trim()) {
			setError(t("auth.emailRequired"));
			return;
		}

		setSubmitting(true);
		const supabase = await getSupabase();
		if (!supabase) {
			setError(t("auth.unavailable"));
			setSubmitting(false);
			return;
		}
		const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim());
		setSubmitting(false);

		if (err) {
			setError(err.message);
			return;
		}
		setSent(true);
		toast.success(t("auth.passwordResetEmailSent"));
	}

	// ── Profile ──

	async function loadProfile(
		userId: string,
		userEmail: string,
	): Promise<import("../types/user-profile").UserProfile | undefined> {
		const supabase = await getSupabase();
		if (!supabase) return undefined;
		const { data: p } = await supabase.from("user_profiles").select("user_name, avatar").eq("id", userId).single();

		const profile = {
			userId,
			email: userEmail,
			userName: p?.user_name || userEmail.split("@")[0],
			handle: "",
			avatar: p?.avatar || "",
		};
		setUserProfile(profile);
		if (api?.updateUserProfile)
			api.updateUserProfile(profile).catch((err) => console.warn("[LoginScreen] updateUserProfile failed:", err));
		return profile;
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

				{mode === "login" && (
					<LoginForm
						email={email}
						setEmail={setEmail}
						password={password}
						setPassword={setPassword}
						submitting={submitting}
						error={error}
						rememberMe={rememberMe}
						setRememberMe={setRememberMe}
						handleLogin={handleLogin}
						onSwitchToForgot={() => {
							setMode("forgot");
							reset();
						}}
						onSwitchToRegister={() => {
							setMode("register");
							reset();
						}}
					/>
				)}

				{mode === "register" && !sent && (
					<RegisterForm
						email={email}
						setEmail={setEmail}
						password={password}
						setPassword={setPassword}
						submitting={submitting}
						error={error}
						handleRegister={handleRegister}
						onSwitchToLogin={() => {
							setMode("login");
							reset();
						}}
					/>
				)}

				{mode === "register" && sent && (
					<RegisterSent
						email={email}
						onBackToLogin={() => {
							setMode("login");
							reset();
						}}
					/>
				)}

				{mode === "forgot" && !sent && (
					<ForgotForm
						email={email}
						setEmail={setEmail}
						submitting={submitting}
						error={error}
						handleForgot={handleForgot}
						onBackToLogin={() => {
							setMode("login");
							reset();
						}}
					/>
				)}

				{mode === "forgot" && sent && (
					<ForgotSent
						email={email}
						onBackToLogin={() => {
							setMode("login");
							reset();
						}}
					/>
				)}
			</div>
		</div>
	);
}
