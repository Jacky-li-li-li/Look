// ============================================================
// LoginScreen — email OTP (verification code) via Supabase
// Ink Wash design language
// ============================================================

import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import { cn } from "@shared/lib/utils";
import { useAtom } from "jotai";
import { ArrowRight, Loader2, Mail, Hash } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { supabase } from "../lib/supabase";
import { authLoadingAtom, isLoggedInAtom, userProfileAtom } from "../store/authAtoms";
import { PixelAgentAvatar } from "./PixelAgentAvatar";

const api = (window as any).look;

type Step = "email" | "code";

export default function LoginScreen() {
	const { t } = useTranslation();
	const [, setIsLoggedIn] = useAtom(isLoggedInAtom);
	const [, setAuthLoading] = useAtom(authLoadingAtom);
	const [, setUserProfile] = useAtom(userProfileAtom);

	const [step, setStep] = useState<Step>("email");
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [codeSent, setCodeSent] = useState(false);

	async function handleSendCode(e: React.FormEvent) {
		e.preventDefault();
		setError(null);

		if (!email.trim()) {
			setError(t("auth.emailRequired", "Email is required"));
			return;
		}

		setSubmitting(true);
		const { error: otpError } = await supabase.auth.signInWithOtp({
			email: email.trim(),
			options: { shouldCreateUser: true },
		});

		if (otpError) {
			setError(otpError.message);
			setSubmitting(false);
			return;
		}

		setCodeSent(true);
		setSubmitting(false);
		setStep("code");
		toast(t("auth.codeSent", "Verification code sent to your email"));
	}

	async function handleVerifyCode(e: React.FormEvent) {
		e.preventDefault();
		setError(null);

		if (code.length < 6) {
			setError(t("auth.codeMinLength", "Please enter the 6-digit code"));
			return;
		}

		setSubmitting(true);
		const { data, error: verifyError } = await supabase.auth.verifyOtp({
			email: email.trim(),
			token: code.trim(),
			type: "email",
		});

		if (verifyError || !data.user) {
			setError(verifyError?.message ?? t("auth.verifyFailed", "Verification failed"));
			setSubmitting(false);
			return;
		}

		await loadProfile(data.user.id, data.user.email ?? email);
		setIsLoggedIn(true);
		setAuthLoading(false);
	}

	function handleBack() {
		setStep("email");
		setCode("");
		setError(null);
	}

	async function handleResendCode() {
		setError(null);
		setSubmitting(true);
		const { error: otpError } = await supabase.auth.signInWithOtp({
			email: email.trim(),
			options: { shouldCreateUser: true },
		});
		setSubmitting(false);

		if (otpError) {
			setError(otpError.message);
			return;
		}
		toast(t("auth.codeResent", "A new code has been sent"));
	}

	async function loadProfile(userId: string, userEmail: string) {
		const { data: cloudProfile } = await supabase
			.from("user_profiles")
			.select("user_name, avatar")
			.eq("id", userId)
			.single();

		if (cloudProfile) {
			setUserProfile({
				userId,
				email: userEmail,
				userName: cloudProfile.user_name || userEmail.split("@")[0],
				avatar: cloudProfile.avatar || "",
			});
			if (api?.updateUserProfile) {
				api.updateUserProfile({
					userId,
					email: userEmail,
					userName: cloudProfile.user_name || userEmail.split("@")[0],
					avatar: cloudProfile.avatar || "",
				}).catch(() => {});
			}
			return;
		}

		if (api?.getUserProfile) {
			const r = await api.getUserProfile().catch(() => null);
			if (r?.success && r.profile?.userId === userId) {
				setUserProfile(r.profile);
				return;
			}
		}

		setUserProfile({ userId, email: userEmail, userName: userEmail.split("@")[0], avatar: "" });
	}

	return (
		<div className="flex h-screen flex-col items-center justify-center bg-background p-6">
			<div className="w-full max-w-sm">
				{/* Logo */}
				<div className="mb-8 flex flex-col items-center gap-3">
					<PixelAgentAvatar size="lg" active />
					<h1 className="text-xl font-semibold tracking-tight text-foreground">Look</h1>
					<p className="text-xs text-muted-foreground">
						{step === "email"
							? t("auth.enterEmail", "Enter your email to sign in or create an account")
							: t("auth.enterCode", "Enter the verification code sent to your email")}
					</p>
				</div>

				{step === "email" ? (
					<form onSubmit={handleSendCode} className="flex flex-col gap-4">
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
									{t("auth.sendCode", "Send Verification Code")}
									<ArrowRight className="ml-2 size-4" />
								</>
							)}
						</Button>
					</form>
				) : (
					<form onSubmit={handleVerifyCode} className="flex flex-col gap-4">
						{/* Show masked email */}
						<div className="rounded-lg border border-hairline bg-muted/30 px-3 py-2 text-center text-[12px] text-muted-foreground">
							{t("auth.codeSentTo", "Code sent to")}{" "}
							<span className="font-medium text-foreground">{email}</span>
						</div>

						<div className="relative">
							<Hash className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input
								type="text"
								inputMode="numeric"
								maxLength={6}
								placeholder="000000"
								value={code}
								onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
								className="h-11 pl-10 text-center text-[18px] tracking-[0.3em]"
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
							disabled={submitting || code.length < 6}
							className={cn("h-11 w-full text-[13px] font-medium", submitting && "opacity-70")}
						>
							{submitting ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<>
									{t("auth.verifyBtn", "Verify & Sign In")}
									<ArrowRight className="ml-2 size-4" />
								</>
							)}
						</Button>

						<div className="flex justify-center gap-4 text-[12px]">
							<button
								type="button"
								onClick={handleBack}
								disabled={submitting}
								className="text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
							>
								{t("auth.changeEmail", "Change email")}
							</button>
							<button
								type="button"
								onClick={handleResendCode}
								disabled={submitting}
								className="text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
							>
								{t("auth.resendCode", "Resend code")}
							</button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}
