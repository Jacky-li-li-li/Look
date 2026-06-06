// ============================================================
// SettingsDialog — Flex layout + inline expand (Ink Wash)
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Button } from "@shared/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@shared/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@shared/components/ui/dialog";
import { Input } from "@shared/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@shared/components/ui/select";
import { Switch } from "@shared/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@shared/components/ui/tabs";
import { Textarea } from "@shared/components/ui/textarea";
import { cn } from "@shared/lib/utils";
import {
	AlertCircle,
	Check,
	Cpu,
	Eye,
	EyeOff,
	Key,
	Loader2,
	MessageSquare,
	Moon,
	Palette,
	Settings,
	ShieldCheck,
	Sun,
	Terminal,
	Trash2,
	Zap,
} from "lucide-react";
import { useTheme } from "next-themes";
import React, { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { showError } from "../lib/ipc";
import { PixelAgentAvatar } from "./PixelAgentAvatar";

const api = (window as any).look;

interface ProviderInfo {
	id: string;
	name: string;
	hasKey: boolean;
	envVar: string;
	modelsAvailable: number;
	authSource?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	envLabel?: string;
}

interface SettingsDialogProps {
	open: boolean;
	providers: ProviderInfo[];
	onProvidersChange: (providers: ProviderInfo[]) => void;
	onClose: () => void;
	/** Which tab to show on open. Defaults to "general". */
	defaultTab?: "general" | "api-keys" | "chat-prompt" | "about";
}

const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;

type TestVerdict = { verdict: "ok" | "error" | "skipped"; reason?: string } | null;

// ── Reusable setting row ──
function SettingRow({
	label,
	desc,
	id,
	children,
}: {
	label: string;
	desc: string;
	id?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-4 py-2.5">
			<div className="flex flex-col gap-0.5 min-w-0">
				<label htmlFor={id} className="text-[13px] font-medium leading-none cursor-pointer">
					{label}
				</label>
				<span className="text-[11px] text-muted-foreground leading-tight">{desc}</span>
			</div>
			{children}
		</div>
	);
}

// ── Auth-source label helper for the env sub-tab ──
// Maps the pi SDK auth source to a short badge label and a hover
// title. The user can't edit these (they're set outside the app),
// but they should be able to tell *why* the credential exists.
function authSourceLabel(source: string, envLabel?: string): { label: string; title: string } {
	switch (source) {
		case "environment":
			return {
				label: "env",
				title: envLabel ? `Detected from $${envLabel} in environment` : "Detected from environment",
			};
		case "runtime":
			return { label: "runtime", title: "Provided at runtime" };
		case "models_json_key":
		case "models_json_command":
			return {
				label: "models.json",
				title: "Configured via ~/.pi/agent/models.json",
			};
		default:
			return { label: "auto", title: `Auto-configured (${source})` };
	}
}

// ── Right-side content panel — symmetric border container matching the
//    left sidebar so the settings page reads as "two framed panels".
//    Owns its own scroll (overflow-y-auto + min-h-0) so the border
//    stays intact top-to-bottom and the scrollbar sits inside the
//    framed panel rather than at the TabsContent edge. Callers pass
//    their own gap / alignment via className. ──
function ContentPanel({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<div
			className={cn(
				"flex h-full min-h-0 flex-col overflow-y-auto rounded-lg border border-hairline bg-muted/30 p-4",
				className,
			)}
		>
			{children}
		</div>
	);
}

function SettingsDialogImpl({
	open,
	providers,
	onProvidersChange,
	onClose,
	defaultTab = "general",
}: SettingsDialogProps) {
	const { theme, setTheme } = useTheme();
	const [language, setLanguage] = useState("en");
	const [thinkingLevel, setThinkingLevel] = useState("medium");
	const [autoCollapse, setAutoCollapse] = useState(true);
	const [autoCompress, setAutoCompress] = useState(false);
	const [compressThreshold, setCompressThreshold] = useState(60);
	const [chatSystemPrompt, setChatSystemPrompt] = useState("");
	const [_settingsLoaded, setSettingsLoaded] = useState(false);
	// Controlled tab — re-syncs to the requested default each time the
	// dialog opens (handled by the parent remounting via the `open`
	// gate, but we also reset on prop change to be safe).
	const [tab, setTab] = useState<string>(defaultTab);
	useEffect(() => {
		setTab(defaultTab);
	}, [defaultTab]);

	// Load persisted settings on mount
	useEffect(() => {
		if (!api) return;
		api.getGeneralSettings()
			.then((r: any) => {
				if (r?.success && r.settings) {
					if (r.settings.language) setLanguage(r.settings.language);
					if (r.settings.defaultThinkingLevel) setThinkingLevel(r.settings.defaultThinkingLevel);
					if (r.settings.autoCollapse !== undefined) setAutoCollapse(r.settings.autoCollapse);
					if (r.settings.autoCompress !== undefined) setAutoCompress(r.settings.autoCompress);
					if (r.settings.compressThreshold !== undefined) setCompressThreshold(r.settings.compressThreshold);
					if (r.settings.chatSystemPrompt !== undefined) setChatSystemPrompt(r.settings.chatSystemPrompt);
					setSettingsLoaded(true);
				}
			})
			.catch(() => setSettingsLoaded(true));
	}, []);

	const [editing, setEditing] = useState<string | null>(null);
	const [keyInput, setKeyInput] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [saving, setSaving] = useState(false);
	const [loadingKey, setLoadingKey] = useState(false);
	// Per-provider self-test status. Lives only for the session — we don't
	// persist verification state because provider keys can be revoked server-
	// side at any time.
	const [testStatus, setTestStatus] = useState<Record<string, TestVerdict>>({});
	// env-var self-test status. Same lifetime as testStatus but kept
	// separate so the env sub-tab can show its own verified badge
	// without colliding with stored-key verdicts.
	const [envTestStatus, setEnvTestStatus] = useState<Record<string, TestVerdict>>({});
	// Confirm-save dialog: shown when the self-test failed but the user
	// still wants to write the key (network blip, key rotated upstream,
	// etc.).
	const [forceSave, setForceSave] = useState<{ provider: string; key: string; reason: string; status: number } | null>(
		null,
	);

	// Reset inline editing state when dialog opens
	useEffect(() => {
		setEditing(null);
		setKeyInput("");
		setShowKey(false);
	}, []);

	const appVersion = "1.0.0";

	// Providers are now hoisted to App.tsx and passed in as a prop — avoids the
	// IPC + main-process model-registry walk on every dialog open.
	const loading = providers.length === 0 && !!api;

	const handleSave = async () => {
		if (!editing || !api || !keyInput.trim()) return;
		const providerId = editing;
		const key = keyInput.trim();
		setSaving(true);
		// Run the live self-test first. Three outcomes:
		//   - ok       → save immediately, mark green
		//   - skipped  → no test config for this provider; save with neutral mark
		//   - error    → ask the user before saving (network blip? stale key?)
		let testResult: { ok?: boolean; skipped?: boolean; status?: number; error?: string; reason?: string } | null =
			null;
		try {
			const r = await api.testApiKey(providerId, key);
			if (r?.success) testResult = r.result;
		} catch {
			/* swallow — fall through to "no test result" branch */
		}
		if (!testResult || (testResult.ok === undefined && !testResult.skipped)) {
			// No result at all (IPC failed) — treat as skipped, save anyway.
			testResult = { skipped: true, reason: "Self-test unavailable" };
		}
		if (testResult.ok === true) {
			await persistKey(providerId, key);
			setTestStatus((prev) => ({ ...prev, [providerId]: { verdict: "ok" } }));
			closeEditor();
			return;
		}
		if (testResult.skipped) {
			await persistKey(providerId, key);
			setTestStatus((prev) => ({ ...prev, [providerId]: { verdict: "skipped", reason: testResult.reason } }));
			closeEditor();
			return;
		}
		// Failed — show confirm dialog before saving.
		setSaving(false);
		setForceSave({
			provider: providerId,
			key,
			reason: testResult.error ?? "Unknown error",
			status: testResult.status ?? 0,
		});
	};

	const persistKey = async (providerId: string, key: string) => {
		if (!api) return;
		try {
			const result = await api.setApiKey(providerId, key);
			if (result?.success) {
				onProvidersChange(result.providers);
				toast.success(`${providerId} key updated`);
			} else {
				toast.error(result?.error ?? "Failed to save key");
			}
		} catch (e: any) {
			toast.error(e?.message ?? "Failed to save key");
		}
	};

	const handleForceSave = async () => {
		if (!forceSave) return;
		const { provider, key, reason } = forceSave;
		setForceSave(null);
		setSaving(true);
		await persistKey(provider, key);
		setTestStatus((prev) => ({ ...prev, [provider]: { verdict: "error", reason } }));
		toast.warning(`${provider} saved despite failed self-test: ${reason}`);
		closeEditor();
	};

	const closeEditor = () => {
		setSaving(false);
		setEditing(null);
		setKeyInput("");
		setShowKey(false);
	};

	const handleClearKey = async (providerId: string) => {
		if (!api) return;
		try {
			const result = await api.setApiKey(providerId, "");
			if (result?.success) {
				onProvidersChange(result.providers);
				toast.success(`${providerId} key removed`);
			}
		} catch (e: any) {
			toast.error(e?.message ?? "Failed to clear key");
		}
	};

	// Probe the env-var credential for a provider (read-only path — no
	// key argument, the main process reads process.env itself). Used by
	// the env sub-tab's Test button.
	const handleTestEnv = async (providerId: string) => {
		if (!api) return;
		const r = await api.testEnvKey(providerId);
		if (!r?.success) {
			toast.error("Self-test failed");
			return;
		}
		const result = r.result;
		if (result.ok) {
			setEnvTestStatus((prev) => ({ ...prev, [providerId]: { verdict: "ok" } }));
			toast.success(`${providerId} env key verified`);
		} else if (result.skipped) {
			setEnvTestStatus((prev) => ({ ...prev, [providerId]: { verdict: "skipped", reason: result.reason } }));
			toast.info(result.reason);
		} else {
			setEnvTestStatus((prev) => ({ ...prev, [providerId]: { verdict: "error", reason: result.error } }));
			toast.error(result.error);
		}
	};

	// Persist settings to main process
	const persistSettings = useCallback((partial: Record<string, any>) => {
		if (!api) return;
		api.setGeneralSettings(partial).catch(showError);
	}, []);

	// Provider splits by credential source. Used by the API Keys
	// sub-tabs (stored/unconfigured = editable, env = read-only) and
	// to compute the count badges in the sub-tab triggers.
	//
	// "API Key" sub-tab — everything the user can ACT on:
	//   * user explicitly saved a key (`hasKey === true`)
	//   * OR no auth at all (no authSource, or source === "fallback").
	//     These need a "Set Key" button so the user can self-adapt
	//     every built-in provider pi-ai supports, not just the ones
	//     the SDK happened to auto-detect.
	//
	// "env" sub-tab — read-only auto-detected credentials:
	//   * environment (shell env var) / runtime / models_json_*.
	//     These have a real credential the SDK can use, but the user
	//     didn't put it in the app, so we only let them Test it.
	const storedProviders = providers.filter((p) => p.hasKey || !p.authSource || p.authSource === "fallback");
	const envProviders = providers.filter((p) => !p.hasKey && p.authSource && p.authSource !== "fallback");
	const storedCount = storedProviders.length;
	const envCount = envProviders.length;

	const handleResetDefaults = () => {
		if (api)
			api.resetGeneralSettings().then((r: any) => {
				if (r?.success && r.settings) {
					setLanguage(r.settings.language ?? "en");
					setThinkingLevel(r.settings.defaultThinkingLevel ?? "medium");
					setAutoCollapse(r.settings.autoCollapse ?? true);
					setAutoCompress(r.settings.autoCompress ?? false);
					setCompressThreshold(r.settings.compressThreshold ?? 60);
					setChatSystemPrompt(r.settings.chatSystemPrompt ?? "");
				}
			});
		setTheme("dark");
		toast.success("Settings reset to defaults");
	};

	const configured = providers.filter((p) => p.hasKey).length;

	return (
		<Dialog open={open} onOpenChange={(o) => !o && onClose()}>
			<DialogContent
				forceMount
				className="flex h-[82vh] max-h-[82vh] flex-col sm:max-w-3xl data-[state=closed]:hidden"
				showCloseButton
			>
				<DialogHeader>
					<DialogTitle>Settings</DialogTitle>
					<DialogDescription>Customize appearance, manage API keys, and more.</DialogDescription>
				</DialogHeader>

				<Tabs value={tab} onValueChange={setTab} orientation="vertical" className="flex min-h-0 flex-1 gap-4">
					<TabsList className="!h-full !justify-start w-44 shrink-0 flex-col items-stretch rounded-none border-r border-hairline bg-transparent p-0 gap-0">
						<TabsTrigger
							value="general"
							className="!h-auto !flex-none w-full justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-foreground data-[state=active]:text-foreground data-[state=active]:bg-accent/20 transition-colors"
						>
							<Palette className="size-3.5" />
							General
						</TabsTrigger>
						<TabsTrigger
							value="api-keys"
							className="!h-auto !flex-none w-full justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-foreground data-[state=active]:text-foreground data-[state=active]:bg-accent/20 transition-colors"
						>
							<Key className="size-3.5" />
							<span className="flex-1 text-left">API Keys</span>
							{configured > 0 && (
								<Badge variant="secondary" className="ml-auto h-4 px-1.5 text-[9px]">
									{configured}
								</Badge>
							)}
						</TabsTrigger>
						<TabsTrigger
							value="chat-prompt"
							className="!h-auto !flex-none w-full justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-foreground data-[state=active]:text-foreground data-[state=active]:bg-accent/20 transition-colors"
						>
							<MessageSquare className="size-3.5" />
							Chat Prompt
						</TabsTrigger>
						<TabsTrigger
							value="about"
							className="!h-auto !flex-none w-full justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-foreground data-[state=active]:text-foreground data-[state=active]:bg-accent/20 transition-colors"
						>
							<Zap className="size-3.5" />
							About
						</TabsTrigger>
					</TabsList>

					{/* ─── General ─── */}
					<TabsContent value="general" className="flex-1 min-h-0 data-[state=inactive]:hidden">
						<ContentPanel className="gap-3">
							<Card size="sm">
								<CardHeader className="border-b border-hairline px-4 py-2.5">
									<CardTitle className="flex items-center gap-1.5 text-[13px]">
										<Sun className="size-3.5 text-muted-foreground" />
										Appearance
									</CardTitle>
								</CardHeader>
								<CardContent className="flex flex-col divide-y divide-hairline px-4 py-0">
									<SettingRow id="theme" label="Theme" desc={theme === "dark" ? "Dark mode" : "Light mode"}>
										<div className="flex items-center gap-1.5">
											<Sun className="size-3.5 text-muted-foreground" />
											<Switch
												id="theme"
												size="sm"
												checked={theme === "dark"}
												onCheckedChange={(c) => setTheme(c ? "dark" : "light")}
											/>
											<Moon className="size-3.5 text-muted-foreground" />
										</div>
									</SettingRow>
									<SettingRow id="language" label="Language" desc="Interface language">
										<Select
											value={language}
											onValueChange={(v) => {
												setLanguage(v);
												persistSettings({ language: v });
											}}
										>
											<SelectTrigger id="language" size="sm" className="w-[110px]">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectGroup>
													<SelectItem value="en">English</SelectItem>
													<SelectItem value="zh">中文</SelectItem>
													<SelectItem value="ja">日本語</SelectItem>
												</SelectGroup>
											</SelectContent>
										</Select>
									</SettingRow>
								</CardContent>
							</Card>

							<Card size="sm">
								<CardHeader className="border-b border-hairline px-4 py-2.5">
									<CardTitle className="flex items-center gap-1.5 text-[13px]">
										<Cpu className="size-3.5 text-muted-foreground" />
										Behavior
									</CardTitle>
								</CardHeader>
								<CardContent className="flex flex-col divide-y divide-hairline px-4 py-0">
									<SettingRow id="thinking" label="Default Thinking" desc="Reasoning depth for new agents">
										<Select
											value={thinkingLevel}
											onValueChange={(v) => {
												setThinkingLevel(v);
												persistSettings({ defaultThinkingLevel: v });
											}}
										>
											<SelectTrigger id="thinking" size="sm" className="w-[100px]">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectGroup>
													{THINKING_LEVELS.map((l) => (
														<SelectItem key={l} value={l}>
															{l}
														</SelectItem>
													))}
												</SelectGroup>
											</SelectContent>
										</Select>
									</SettingRow>
									<SettingRow id="autoclp" label="Auto-collapse" desc="Collapse steps after completion">
										<Switch
											id="autoclp"
											size="sm"
											checked={autoCollapse}
											onCheckedChange={(v) => {
												setAutoCollapse(v);
												persistSettings({ autoCollapse: v });
											}}
										/>
									</SettingRow>
								</CardContent>
							</Card>

							<Card size="sm">
								<CardHeader className="border-b border-hairline px-4 py-2.5">
									<CardTitle className="flex items-center gap-1.5 text-[13px]">
										<Zap className="size-3.5 text-muted-foreground" />
										Compression
									</CardTitle>
								</CardHeader>
								<CardContent className="flex flex-col divide-y divide-hairline px-4 py-0">
									<SettingRow
										id="autocompress"
										label="Auto-compress"
										desc="Compact context when threshold reached"
									>
										<Switch
											id="autocompress"
											size="sm"
											checked={autoCompress}
											onCheckedChange={(v) => {
												setAutoCompress(v);
												persistSettings({ autoCompress: v });
											}}
										/>
									</SettingRow>
									<SettingRow
										id="compressThreshold"
										label="Compress at"
										desc={`Auto-compress when context exceeds ${compressThreshold}%`}
									>
										<div className="flex items-center gap-2">
											<input
												id="compressThreshold"
												type="range"
												min={40}
												max={95}
												step={5}
												value={compressThreshold}
												onChange={(e) => {
													const v = Number(e.target.value);
													setCompressThreshold(v);
													persistSettings({ compressThreshold: v });
												}}
												className="w-20 h-1.5 cursor-pointer accent-foreground appearance-none rounded-full bg-muted-foreground/20 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground"
											/>
											<span className="w-8 text-right text-[11px] font-mono tabular-nums text-muted-foreground">
												{compressThreshold}%
											</span>
										</div>
									</SettingRow>
								</CardContent>
							</Card>
						</ContentPanel>
					</TabsContent>

					{/* ─── Chat Prompt ─── */}
					<TabsContent value="chat-prompt" className="flex-1 min-h-0 data-[state=inactive]:hidden">
						<ContentPanel className="gap-3">
							<div className="flex flex-col gap-3">
								<div className="flex flex-col gap-0.5">
									<h3 className="text-[13px] font-medium leading-none">Chat System Prompt</h3>
									<span className="text-[11px] text-muted-foreground leading-tight">
										Custom instructions for new chat sessions. Leave empty to use the pi SDK default coding
										assistant prompt.
									</span>
								</div>
								<Textarea
									id="chatSystemPrompt"
									placeholder="Leave empty to use the pi SDK default coding assistant prompt."
									value={chatSystemPrompt}
									onChange={(e) => setChatSystemPrompt(e.target.value)}
									onBlur={() => persistSettings({ chatSystemPrompt })}
									className="min-h-[200px] text-[13px]"
								/>
							</div>
						</ContentPanel>
					</TabsContent>

					{/* ─── API Keys ─── */}
					<TabsContent value="api-keys" className="flex-1 min-h-0 data-[state=inactive]:hidden">
						{loading ? (
							<ContentPanel>
								<div className="flex items-center justify-center py-12 text-[12px] text-muted-foreground">
									Loading providers…
								</div>
							</ContentPanel>
						) : (
							// Nested tabs split credentials by source — stored keys
							// (editable) vs env-detected (read-only + Test). Single
							// ContentPanel hosts the sticky tab header + the
							// scrollable list. The tab header sticks to the top
							// of the panel so the list scrolls under it.
							<ContentPanel className="overflow-hidden p-0">
								<Tabs defaultValue="api-key" className="flex h-full min-h-0 flex-col">
									<TabsList className="!flex !h-auto !justify-start sticky top-0 z-10 w-full self-stretch gap-0 rounded-none border-b border-hairline bg-popover/80 px-0 py-0 backdrop-blur">
										<TabsTrigger
											value="api-key"
											className="!h-auto !flex-none !justify-start gap-1.5 rounded-none border-b-2 border-transparent px-3 py-1.5 text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground"
										>
											<Key className="size-3.5" />
											API Key
											{storedCount > 0 && (
												<Badge variant="secondary" className="ml-1 h-4 px-1 text-[9px]">
													{storedCount}
												</Badge>
											)}
										</TabsTrigger>
										<TabsTrigger
											value="env"
											className="!h-auto !flex-none !justify-start gap-1.5 rounded-none border-b-2 border-transparent px-3 py-1.5 text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground"
										>
											<Terminal className="size-3.5" />
											env
											{envCount > 0 && (
												<Badge variant="secondary" className="ml-1 h-4 px-1 text-[9px]">
													{envCount}
												</Badge>
											)}
										</TabsTrigger>
									</TabsList>

									{/* ── Sub-tab: stored API keys (editable) ── */}
									<TabsContent
										value="api-key"
										className="flex-1 min-h-0 overflow-y-auto data-[state=inactive]:hidden"
									>
										<div className="flex flex-col gap-0.5 p-3">
											{storedProviders.map((p) => {
												const isEditing = editing === p.id;
												const ts = testStatus[p.id];
												return (
													<div
														key={p.id}
														className={cn(
															"overflow-hidden rounded-lg border transition-colors",
															isEditing ? "border-hairline" : "border-transparent",
															"bg-muted/40",
														)}
													>
														<div className="flex items-center justify-between gap-3 px-3 py-2">
															<div className="min-w-0 flex-1">
																<div className="flex items-center gap-2 text-[13px] font-medium">
																	<span
																		className={cn(
																			"size-2 shrink-0 rounded-full",
																			p.hasKey ? "bg-emerald-500" : "bg-muted-foreground/30",
																		)}
																	/>
																	{p.name}
																	<Badge variant="outline" className="h-4.5 gap-1 px-1.5 text-[10px]">
																		<Check className="size-2.5" />
																		{p.modelsAvailable}
																	</Badge>
																	{ts?.verdict === "ok" && (
																		<span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
																			<ShieldCheck className="size-2.5" />
																			Verified
																		</span>
																	)}
																	{ts?.verdict === "error" && (
																		<span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 dark:text-rose-400">
																			<AlertCircle className="size-2.5" />
																			Failed
																		</span>
																	)}
																	{ts?.verdict === "skipped" && ts.reason?.includes("复杂认证") && (
																		<span
																			className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
																			title={ts.reason}
																		>
																			复杂认证
																		</span>
																	)}
																	{ts?.verdict === "skipped" && !ts.reason?.includes("复杂认证") && (
																		<span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
																			Untested
																		</span>
																	)}
																</div>
																<code className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
																	{p.envVar}
																</code>
															</div>
															<div className="flex shrink-0 items-center gap-1">
																<Button
																	variant={isEditing ? "line-filled" : "line"}
																	size="xs"
																	className="h-7 text-[11px]"
																	onClick={async () => {
																		if (isEditing) {
																			setEditing(null);
																			setKeyInput("");
																			setShowKey(false);
																		} else {
																			setEditing(p.id);
																			setShowKey(false);
																			if (p.hasKey && api) {
																				setLoadingKey(true);
																				setKeyInput("");
																				try {
																					const r = await api.getApiKey(p.id);
																					if (r?.success && r.key) setKeyInput(r.key);
																				} catch {
																					/* leave empty */
																				}
																				setLoadingKey(false);
																			} else {
																				setKeyInput("");
																			}
																		}
																	}}
																>
																	<Key data-icon="inline-start" className="size-3" />
																	{isEditing ? "Cancel" : "Edit"}
																</Button>
																{!isEditing && (
																	<Button
																		variant="line-ghost"
																		size="icon-xs"
																		className="h-7 w-7 text-muted-foreground hover:text-destructive"
																		onClick={() => handleClearKey(p.id)}
																	>
																		<Trash2 className="size-3" />
																	</Button>
																)}
															</div>
														</div>

														{isEditing && (
															<div className="border-t border-hairline bg-muted/30 px-3 pb-3 pt-2">
																<div className="flex gap-2">
																	<div className="relative flex-1">
																		<Input
																			type={showKey ? "text" : "password"}
																			value={keyInput}
																			onChange={(e) => setKeyInput(e.target.value)}
																			onKeyDown={(e) => {
																				if (e.key === "Enter") handleSave();
																				if (e.key === "Escape") {
																					setEditing(null);
																					setKeyInput("");
																					setShowKey(false);
																				}
																			}}
																			placeholder={loadingKey ? "Loading…" : "sk-..."}
																			autoFocus
																			disabled={loadingKey}
																			className="h-8 pr-9 font-mono text-[12px]"
																		/>
																		<Button
																			variant="ghost"
																			size="icon"
																			className="absolute right-0 top-0 size-8"
																			onClick={() => setShowKey(!showKey)}
																			tabIndex={-1}
																		>
																			{showKey ? (
																				<EyeOff data-icon="inline-start" />
																			) : (
																				<Eye data-icon="inline-start" />
																			)}
																		</Button>
																	</div>
																	<Button
																		variant="line-filled"
																		size="sm"
																		className="h-8 text-[11px]"
																		onClick={handleSave}
																		disabled={saving || !keyInput.trim()}
																	>
																		{saving ? (
																			<>
																				<Loader2
																					data-icon="inline-start"
																					className="size-3 animate-spin"
																				/>
																				Testing…
																			</>
																		) : (
																			<>
																				<ShieldCheck data-icon="inline-start" className="size-3" />
																				Save
																			</>
																		)}
																	</Button>
																</div>
																<p className="mt-1.5 text-[10px] text-muted-foreground">
																	Or set{" "}
																	<code className="rounded bg-muted px-1 font-mono text-[10px]">
																		export {p.envVar}=...
																	</code>
																</p>
															</div>
														)}
													</div>
												);
											})}
											{storedProviders.length === 0 && (
												<p className="py-8 text-center text-[12px] text-muted-foreground">
													No API keys configured. Add one to get started.
												</p>
											)}
										</div>
									</TabsContent>

									{/* ── Sub-tab: env-detected credentials (read-only + Test) ── */}
									<TabsContent
										value="env"
										className="flex-1 min-h-0 overflow-y-auto data-[state=inactive]:hidden"
									>
										<div className="flex flex-col gap-0.5 p-3">
											{envProviders.map((p) => {
												const ts = envTestStatus[p.id];
												const src = authSourceLabel(p.authSource ?? "", p.envLabel);
												return (
													<div
														key={p.id}
														className="overflow-hidden rounded-lg border border-transparent bg-muted/40"
													>
														<div className="flex items-center justify-between gap-3 px-3 py-2">
															<div className="min-w-0 flex-1">
																<div className="flex items-center gap-2 text-[13px] font-medium">
																	{/* Sky dot — not green. env credentials are
																	    auto-detected (shell var / runtime / models.json),
																	    not user-saved, so the status colour must
																	    differ from the stored-key green dot to avoid
																	    implying "I configured this". */}
																	<span className="size-2 shrink-0 rounded-full bg-sky-500" />
																	{p.name}
																	<Badge
																		variant="secondary"
																		className="h-4.5 gap-1 px-1.5 text-[10px]"
																		title={src.title}
																	>
																		{src.label}
																	</Badge>
																	{ts?.verdict === "ok" && (
																		<span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
																			<ShieldCheck className="size-2.5" />
																			Verified
																		</span>
																	)}
																	{ts?.verdict === "error" && (
																		<span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 dark:text-rose-400">
																			<AlertCircle className="size-2.5" />
																			Failed
																		</span>
																	)}
																	{ts?.verdict === "skipped" && ts.reason?.includes("复杂认证") && (
																		<span
																			className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
																			title={ts.reason}
																		>
																			复杂认证
																		</span>
																	)}
																	{ts?.verdict === "skipped" && !ts.reason?.includes("复杂认证") && (
																		<span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
																			Untested
																		</span>
																	)}
																</div>
																<code className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
																	{p.envVar}
																</code>
															</div>
															<div className="flex shrink-0 items-center gap-1">
																<Button
																	variant="line"
																	size="xs"
																	className="h-7 text-[11px]"
																	onClick={() => handleTestEnv(p.id)}
																>
																	<ShieldCheck data-icon="inline-start" className="size-3" />
																	Test
																</Button>
															</div>
														</div>
													</div>
												);
											})}
											{envProviders.length === 0 && (
												<p className="py-8 text-center text-[12px] text-muted-foreground">
													No env credentials detected. Set provider env vars in your shell to use them.
												</p>
											)}
										</div>
									</TabsContent>
								</Tabs>
							</ContentPanel>
						)}
					</TabsContent>

					{/* ─── About ─── */}
					<TabsContent value="about" className="flex-1 min-h-0 data-[state=inactive]:hidden">
						<ContentPanel className="items-center justify-center gap-5 py-10 text-center">
							<PixelAgentAvatar size="lg" active />
							<div className="flex flex-col items-center gap-1.5">
								<h2 className="text-lg font-semibold tracking-tight">Look</h2>
								<Badge variant="secondary" className="font-mono text-[11px]">
									v{appVersion}
								</Badge>
							</div>
							<p className="text-[13px] text-muted-foreground max-w-xs leading-relaxed">
								Multi-agent orchestration desktop application. Built with Electron, React, and pi SDK.
							</p>
							<div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
								<span className="flex items-center justify-center gap-1.5">
									<Settings className="size-3" /> shadcn/ui + Radix
								</span>
								<span className="flex items-center justify-center gap-1.5">
									<Palette className="size-3" /> Ink Wash design system
								</span>
							</div>
							<p className="text-[10px] text-muted-foreground/60 font-mono">
								{configured} provider{configured !== 1 ? "s" : ""} configured ·{" "}
								{providers.reduce((s, p) => s + p.modelsAvailable, 0)} models
							</p>
						</ContentPanel>
					</TabsContent>
				</Tabs>

				<DialogFooter className="shrink-0 sm:justify-between">
					<Button variant="line" size="sm" className="h-7 text-[11px]" onClick={handleResetDefaults}>
						Reset
					</Button>
					<Button variant="line-filled" size="sm" className="h-7 text-[11px]" onClick={onClose}>
						Done
					</Button>
				</DialogFooter>
			</DialogContent>

			{/* Confirm-save-after-failed-test dialog. Stays separate from the
        main settings dialog so the user can review the error in a
        focused surface and explicitly opt in to saving anyway. */}
			<Dialog open={forceSave !== null} onOpenChange={(o) => !o && setForceSave(null)}>
				<DialogContent className="sm:max-w-md" showCloseButton={false}>
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2 text-rose-600 dark:text-rose-400">
							<AlertCircle className="size-4" />
							Self-test failed for {forceSave?.provider}
						</DialogTitle>
						<DialogDescription>
							Look couldn't verify this key against the provider's API.
							{forceSave?.status ? ` Provider returned HTTP ${forceSave.status}.` : ""}
						</DialogDescription>
					</DialogHeader>
					<div className="rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 font-mono text-[11px] text-rose-700 dark:text-rose-300">
						{forceSave?.reason}
					</div>
					<p className="text-[11px] text-muted-foreground">
						You can still save the key — but the provider will likely reject requests until you replace it with a
						working one.
					</p>
					<DialogFooter className="gap-2">
						<Button variant="line" size="sm" onClick={() => setForceSave(null)}>
							Cancel
						</Button>
						<Button variant="line-filled" size="sm" onClick={handleForceSave}>
							Save anyway
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</Dialog>
	);
}

const SettingsDialog = React.memo(SettingsDialogImpl);
export default SettingsDialog;
