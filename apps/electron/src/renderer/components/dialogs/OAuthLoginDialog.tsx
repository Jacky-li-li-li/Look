// ============================================================
// OAuthLoginDialog — Replaces native Electron dialogs for pi
// provider OAuth login flows. Shows shadcn/ui dialogs for
// prompt, device_code, auth_url, and progress events.
// ============================================================

import { Button } from "@shared/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@shared/components/ui/dialog";
import { useAtom } from "jotai";
import { ExternalLink, Loader2 } from "lucide-react";
import { useCallback } from "react";
import { loginPromptAtom } from "../../store/atoms";

const api = window.look;

export default function OAuthLoginDialog() {
	const [prompt, setPrompt] = useAtom(loginPromptAtom);

	const handleCancel = useCallback(() => {
		if (!prompt) return;
		const promptId = prompt.promptId;
		setPrompt(null);
		api?.cancelLoginPrompt(promptId).catch(() => {});
	}, [prompt, setPrompt]);

	const handleSelect = useCallback(
		async (optionId: string) => {
			if (!prompt) return;
			const promptId = prompt.promptId;
			setPrompt(null);
			await api?.respondLoginPrompt(promptId, optionId);
		},
		[prompt, setPrompt],
	);

	const handleOpenBrowser = useCallback(
		async (url: string) => {
			if (!prompt) return;
			// For auth_url events, we just open the browser and the flow continues
			// automatically via the pi SDK's local callback server.
			const promptId = prompt.promptId;
			window.open(url, "_blank");
			setPrompt(null);
			await api?.respondLoginPrompt(promptId, "");
		},
		[prompt, setPrompt],
	);

	const handleDismiss = useCallback(async () => {
		if (!prompt) return;
		const promptId = prompt.promptId;
		setPrompt(null);
		await api?.respondLoginPrompt(promptId, "");
	}, [prompt, setPrompt]);

	if (!prompt) return null;

	const { prompt: promptData } = prompt;

	return (
		<Dialog
			open={true}
			onOpenChange={(open) => {
				if (!open) handleCancel();
			}}
		>
			<DialogContent className="sm:max-w-sm" showCloseButton={false}>
				{promptData.type === "select" && (
					<>
						<DialogHeader>
							<DialogTitle>{prompt.providerName} Login</DialogTitle>
							<DialogDescription>{promptData.message}</DialogDescription>
						</DialogHeader>
						<div className="flex flex-col gap-2 py-2">
							{promptData.options.map((option) => (
								<Button
									key={option.id}
									variant="line-filled"
									size="sm"
									className="w-full justify-start text-left"
									onClick={() => handleSelect(option.id)}
								>
									{option.label}
								</Button>
							))}
						</div>
						<DialogFooter>
							<Button variant="line" size="sm" onClick={handleCancel}>
								Cancel
							</Button>
						</DialogFooter>
					</>
				)}

				{promptData.type === "manual_code" && (
					<>
						<DialogHeader>
							<DialogTitle>{prompt.providerName} Login</DialogTitle>
							<DialogDescription>{promptData.message}</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button variant="line" size="sm" onClick={handleCancel}>
								Cancel
							</Button>
						</DialogFooter>
					</>
				)}

				{promptData.type === "auth_url" && (
					<>
						<DialogHeader>
							<DialogTitle>{prompt.providerName} Login</DialogTitle>
							<DialogDescription>
								Complete sign-in in your browser.
								{promptData.instructions && (
									<>
										<br />
										{promptData.instructions}
									</>
								)}
							</DialogDescription>
						</DialogHeader>
						<div className="flex justify-center py-4">
							<Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
						</div>
						<DialogFooter className="gap-2">
							<Button variant="line" size="sm" onClick={handleCancel}>
								Cancel
							</Button>
							<Button variant="line-filled" size="sm" onClick={() => handleOpenBrowser(promptData.url)}>
								<ExternalLink className="mr-1.5 size-3.5" aria-hidden="true" />
								Open Browser
							</Button>
						</DialogFooter>
					</>
				)}

				{promptData.type === "device_code" && (
					<>
						<DialogHeader>
							<DialogTitle>{prompt.providerName} Login</DialogTitle>
							<DialogDescription>Your verification code:</DialogDescription>
						</DialogHeader>
						<div className="flex justify-center py-2">
							<code className="rounded-md bg-muted px-4 py-2 font-mono text-lg font-bold tracking-widest">
								{promptData.userCode}
							</code>
						</div>
						<p className="text-center text-[11px] text-muted-foreground">
							Open the verification page and enter this code.
						</p>
						<DialogFooter className="gap-2">
							<Button variant="line" size="sm" onClick={handleCancel}>
								Cancel
							</Button>
							<Button
								variant="line-filled"
								size="sm"
								onClick={() => handleOpenBrowser(promptData.verificationUri)}
							>
								<ExternalLink className="mr-1.5 size-3.5" aria-hidden="true" />
								Open Browser
							</Button>
						</DialogFooter>
					</>
				)}

				{(promptData.type === "info" || promptData.type === "progress") && (
					<>
						<DialogHeader>
							<DialogTitle>{prompt.providerName} Login</DialogTitle>
							{promptData.type === "progress" && (
								<DialogDescription>
									<div className="flex items-center gap-2">
										<Loader2 className="size-4 animate-spin" aria-hidden="true" />
										<span>{promptData.message}</span>
									</div>
								</DialogDescription>
							)}
							{promptData.type === "info" && <DialogDescription>{promptData.message}</DialogDescription>}
						</DialogHeader>
						<DialogFooter>
							<Button variant="line" size="sm" onClick={handleDismiss}>
								OK
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
