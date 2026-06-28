// ============================================================
// ApiKeysTab — Provider API key management
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Button } from "@shared/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@shared/components/ui/dialog";
import { Input } from "@shared/components/ui/input";
import { cn } from "@shared/lib/utils";
import { AlertCircle, Cpu, Eye, EyeOff, Key, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ProviderIcon } from "../ProviderIcon";
import AddCustomProviderDialog from "./AddCustomProviderDialog";
import type { CustomProviderInput, CustomProviderStats, ProviderInfo, ProviderModelInfo, TestVerdict } from "./types";

const api = (window as any).look;

function formatContextWindow(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
	}
	return `${Math.round(tokens / 1000)}K`;
}

function ProviderModelCount({ provider }: { provider: ProviderInfo }) {
	return (
		<Badge variant="outline" className="h-4.5 gap-1 px-1.5 text-[10px]">
			<Cpu className="size-2.5" />
			{provider.modelsAvailable}
		</Badge>
	);
}

function ModelList({ models, t }: { models: ProviderModelInfo[]; t: (key: string) => string }) {
	return (
		<div className="">
			{models.map((model) => (
				<div
					key={model.id}
					className="flex items-start justify-between gap-3 pl-[44px] pr-3 py-1.5 text-left hover:bg-muted/40"
				>
					<div className="min-w-0">
						<div className="truncate text-[12px] font-medium">{model.name}</div>
						<div className="truncate font-mono text-[10px] text-muted-foreground">{model.id}</div>
					</div>
					<span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
						{model.reasoning ? t("agent.modelThink") : t("agent.modelBase")} /{" "}
						{formatContextWindow(model.contextWindow)}
					</span>
				</div>
			))}
		</div>
	);
}

interface ApiKeysTabProps {
	providers: ProviderInfo[];
	customStats: CustomProviderStats;
	onProvidersChange: (data: { providers: ProviderInfo[]; customStats: CustomProviderStats }) => void;
}

export default function ApiKeysTab({ providers, customStats, onProvidersChange }: ApiKeysTabProps) {
	const { t } = useTranslation();
	const [editing, setEditing] = useState<string | null>(null);
	const [keyInput, setKeyInput] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [saving, setSaving] = useState(false);
	const [loadingKey, setLoadingKey] = useState(false);
	const [testStatus, setTestStatus] = useState<Record<string, TestVerdict>>({});

	const [forceSave, setForceSave] = useState<{ provider: string; key: string; reason: string; status: number } | null>(
		null,
	);
	const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});

	// ── Custom providers ──
	const [customView, setCustomView] = useState<{ type: "list" } | { type: "form"; editing?: CustomProviderInput }>({
		type: "list",
	});
	const [customProviders, setCustomProviders] = useState<CustomProviderInput[]>([]);
	const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

	const loadCustomProviders = useCallback(async () => {
		if (!api) return;
		try {
			const r = await api.listCustomProviders();
			if (r?.success) setCustomProviders(r.providers ?? []);
		} catch {
			/* ignore */
		}
	}, []);

	useEffect(() => {
		loadCustomProviders();
	}, [loadCustomProviders]);

	const handleRemoveCustom = async () => {
		if (!confirmRemove || !api) return;
		try {
			const r = await api.removeCustomProvider(confirmRemove);
			if (r?.success && r.removed) {
				toast.success(t("settings.customProviders.toast.removed"));
				loadCustomProviders();
				try {
					const providersRes = await api.getSettings();
					if (providersRes?.success)
						onProvidersChange({ providers: providersRes.providers, customStats: providersRes.customStats });
				} catch {}
			}
		} catch (e: any) {
			toast.error(e?.message ?? t("settings.customProviders.toast.removeFailed"));
		}
		setConfirmRemove(null);
	};

	const toggleProviderExpand = (id: string) => {
		setExpandedProviders((prev) => ({ ...prev, [id]: !prev[id] }));
	};

	useEffect(() => {
		setEditing(null);
		setKeyInput("");
		setShowKey(false);
	}, []);

	const persistKey = async (providerId: string, key: string) => {
		if (!api) return;
		try {
			const result = await api.setApiKey(providerId, key);
			if (result?.success) {
				onProvidersChange({ providers: result.providers, customStats: result.customStats });
				toast.success(t("settings.keyUpdated", { provider: providerId }));
			} else {
				toast.error(result?.error ?? t("settings.selfTestFailed"));
			}
		} catch (e: any) {
			toast.error(e?.message ?? t("settings.selfTestFailed"));
		}
	};

	const closeEditor = () => {
		setSaving(false);
		setEditing(null);
		setKeyInput("");
		setShowKey(false);
	};

	const handleSave = async () => {
		if (!editing || !api || !keyInput.trim()) return;
		const providerId = editing;
		const key = keyInput.trim();
		setSaving(true);
		let testResult: { ok?: boolean; skipped?: boolean; status?: number; error?: string; reason?: string } | null =
			null;
		try {
			const r = await api.testApiKey(providerId, key);
			if (r?.success) testResult = r.result;
		} catch {
			/* swallow */
		}
		if (!testResult || (testResult.ok === undefined && !testResult.skipped)) {
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
		setSaving(false);
		setForceSave({
			provider: providerId,
			key,
			reason: testResult.error ?? "Unknown error",
			status: testResult.status ?? 0,
		});
	};

	const handleForceSave = async () => {
		if (!forceSave) return;
		const { provider, key, reason } = forceSave;
		setForceSave(null);
		setSaving(true);
		await persistKey(provider, key);
		setTestStatus((prev) => ({ ...prev, [provider]: { verdict: "error", reason } }));
		toast.warning(t("settings.failedSelfTest", { provider, reason }));
		closeEditor();
	};

	const handleClearKey = async (providerId: string) => {
		if (!api) return;
		try {
			const result = await api.setApiKey(providerId, "");
			if (result?.success) {
				onProvidersChange({ providers: result.providers, customStats: result.customStats });
				toast.success(t("settings.keyRemoved", { provider: providerId }));
			}
		} catch (e: any) {
			toast.error(e?.message ?? t("settings.selfTestFailed"));
		}
	};

	const allProviders = [...providers].sort((a, b) => (b.hasKey ? 1 : 0) - (a.hasKey ? 1 : 0));

	// ── Inline form view ──
	if (customView.type === "form") {
		return (
			<AddCustomProviderDialog
				key={customView.editing ? `edit-${customView.editing.name}` : "add"}
				open={true}
				onClose={() => setCustomView({ type: "list" })}
				initial={customView.editing}
				onSaved={() => {
					loadCustomProviders();
					setCustomView({ type: "list" });
					api?.getSettings?.()
						.then((r: any) => {
							if (r?.success) onProvidersChange({ providers: r.providers, customStats: r.customStats });
						})
						.catch(() => {});
				}}
				mode="inline"
				onBack={() => setCustomView({ type: "list" })}
			/>
		);
	}

	if (providers.length === 0) {
		return (
			<div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
				<div className="mb-3">
					<h2 className="text-[13px] font-medium">{t("settings.apiKeys")}</h2>
					<p className="text-[11px] text-muted-foreground">{t("settings.apiKeysDescription")}</p>
				</div>
				<div className="flex items-center justify-center py-12 text-[12px] text-muted-foreground">
					{t("common.loading")}
				</div>
			</div>
		);
	}

	return (
		<>
			<div className="flex h-full min-h-0 flex-col overflow-y-auto p-0">
				<div className="px-3 pt-3 pb-1.5">
					<h2 className="text-[13px] font-medium">{t("settings.apiKeys")}</h2>
					<p className="text-[11px] text-muted-foreground">{t("settings.apiKeysDescription")}</p>
				</div>
				<div className="flex flex-col gap-0.5 p-3 pt-0">
					{/* Custom providers section */}
					<div className="border-b border-hairline px-3 py-2">
						<div className="flex items-center justify-between">
							<span className="text-[11px] font-medium text-muted-foreground">
								{t("settings.customProviders.title")}
							</span>
							<Button
								variant="line"
								size="xs"
								className="h-7 text-[10px]"
								onClick={() => setCustomView({ type: "form" })}
							>
								<Plus className="size-3" data-icon="inline-start" />
								{t("settings.customProviders.addButton")}
							</Button>
						</div>
						{customProviders.length > 0 ? (
							<div className="mt-1.5 space-y-1">
								{customProviders.map((cp) => (
									<div
										key={cp.name}
										className="flex items-center justify-between rounded-md border border-hairline bg-muted/40 px-2.5 py-1.5"
									>
										<div className="min-w-0 flex-1">
											<span className="inline-block max-w-full truncate font-mono text-[12px]">
												{cp.name}
											</span>
											<span className="ml-2 whitespace-nowrap text-[10px] text-muted-foreground">
												{t("settings.customProviders.modelCount", { count: cp.models.length })} · {cp.api}
											</span>
										</div>
										<div className="flex shrink-0 items-center gap-1">
											<Button
												variant="line"
												size="xs"
												className="h-6 text-[10px]"
												onClick={() => {
													setCustomView({ type: "form", editing: cp });
												}}
											>
												{t("settings.customProviders.edit")}
											</Button>
											<Button
												variant="line-ghost"
												size="icon-xs"
												className="h-6 w-6 text-muted-foreground hover:text-destructive"
												onClick={() => setConfirmRemove(cp.name)}
											>
												<Trash2 className="size-3" />
											</Button>
										</div>
									</div>
								))}
							</div>
						) : (
							<p className="mt-1 text-[10px] text-muted-foreground">{t("settings.customProviders.empty")}</p>
						)}
					</div>

					{/* Provider API section */}
					<div className="border-b border-hairline px-3 py-2">
						<span className="text-[11px] font-medium text-muted-foreground">{t("settings.providers.title")}</span>
					</div>

					{allProviders.map((p) => {
						const isEditing = editing === p.id;
						const ts = testStatus[p.id];
						return (
							<div
								key={p.id}
								className={cn(
									"overflow-hidden rounded-md border border-hairline bg-muted/40",
									isEditing && "ring-1 ring-primary/50",
								)}
							>
								<div className="group flex items-center justify-between gap-3 px-2.5 py-1.5">
									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap items-center gap-1.5">
											<ProviderIcon id={p.id} className="size-4 shrink-0" />
											<span
												className={cn(
													"size-2 shrink-0 rounded-full",
													p.hasKey ? "bg-emerald-500" : "bg-muted-foreground/30",
												)}
											/>
											<span
												className={cn(
													"min-w-0 cursor-pointer truncate text-[12px] font-medium transition-colors hover:text-foreground",
													(!p.models || p.models.length === 0) && "cursor-default",
												)}
												onClick={() => p.models && p.models.length > 0 && toggleProviderExpand(p.id)}
												role="button"
												tabIndex={0}
												onKeyDown={(e) => {
													if (e.key === "Enter" || e.key === " ") toggleProviderExpand(p.id);
												}}
											>
												{p.name}
											</span>
											<ProviderModelCount provider={p} />
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
											{ts?.verdict === "skipped" && (
												<span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
													Untested
												</span>
											)}
										</div>
										{p.envVar && (
											<code className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
												{p.envVar}
											</code>
										)}
									</div>
									<div
										className={cn(
											"flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100",
											isEditing && "opacity-100",
										)}
									>
										<Button
											variant={isEditing ? "line-filled" : "line"}
											size="xs"
											className="h-6 text-[10px]"
											onClick={async () => {
												if (isEditing) {
													closeEditor();
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
											{isEditing ? t("common.cancel") : t("settings.setKey")}
										</Button>
										{!isEditing && (
											<Button
												variant="line-ghost"
												size="icon-xs"
												className="h-6 w-6 text-muted-foreground hover:text-destructive"
												onClick={() => handleClearKey(p.id)}
											>
												<Trash2 className="size-3" />
											</Button>
										)}
									</div>
								</div>

								{expandedProviders[p.id] && p.models && p.models.length > 0 && (
									<ModelList models={p.models} t={t} />
								)}

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
															closeEditor();
														}
													}}
													placeholder={loadingKey ? t("common.loading") : "sk-..."}
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
														<Loader2 data-icon="inline-start" className="size-3 animate-spin" />
														{t("settings.testKey")}…
													</>
												) : (
													<>
														<ShieldCheck data-icon="inline-start" className="size-3" />
														{t("common.save")}
													</>
												)}
											</Button>
										</div>
										{p.envVar && (
											<p className="mt-1.5 text-[10px] text-muted-foreground">
												Or set{" "}
												<code className="rounded bg-muted px-1 font-mono text-[10px]">
													export {p.envVar}=...
												</code>
											</p>
										)}
									</div>
								)}
							</div>
						);
					})}
				</div>
			</div>
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
							{t("common.cancel")}
						</Button>
						<Button variant="line-filled" size="sm" onClick={handleForceSave}>
							Save anyway
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Confirm remove custom provider */}
			<Dialog open={confirmRemove !== null} onOpenChange={(o) => !o && setConfirmRemove(null)}>
				<DialogContent className="sm:max-w-sm" showCloseButton={false}>
					<DialogHeader>
						<DialogTitle>{t("settings.customProviders.confirmRemove.title")}</DialogTitle>
						<DialogDescription>
							{t("settings.customProviders.confirmRemove.body", { name: confirmRemove ?? "" })}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter className="gap-2">
						<Button variant="line" size="sm" onClick={() => setConfirmRemove(null)}>
							{t("common.cancel")}
						</Button>
						<Button variant="line-filled" size="sm" onClick={handleRemoveCustom}>
							{t("common.delete")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
