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
import { AlertCircle, ChevronRight, Cpu, Eye, EyeOff, Key, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ProviderIcon } from "../ProviderIcon";
import AddCustomProviderDialog from "./AddCustomProviderDialog";
import type { CustomProviderInput, CustomProviderStats, ProviderInfo, ProviderModelInfo, TestVerdict } from "./types";

const api = (window as any).look;

type ForceSaveState = { provider: string; key: string; reason: string; status: number } | null;

function formatContextWindow(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
	}
	return `${Math.round(tokens / 1000)}K`;
}

function ProviderModelCount({ provider }: { provider: ProviderInfo }) {
	return (
		<Badge variant="outline" className="h-5 gap-1 px-1.5 font-mono text-[10px]">
			<Cpu className="size-2.5" />
			{provider.modelsAvailable}
		</Badge>
	);
}

function ModelList({ models, t }: { models: ProviderModelInfo[]; t: (key: string) => string }) {
	return (
		<div className="border-t border-hairline bg-background/45 px-3 py-1.5">
			<div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_auto_auto] gap-3 px-2 pb-1 text-[9px] font-medium text-muted-foreground">
				<span>{t("settings.modelTable.name")}</span>
				<span>{t("settings.modelTable.id")}</span>
				<span>{t("settings.modelTable.type")}</span>
				<span>{t("settings.modelTable.context")}</span>
			</div>
			{models.map((model) => (
				<div
					key={model.id}
					className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_auto_auto] items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted/45"
				>
					<div className="min-w-0 truncate text-[12px] font-medium">{model.name}</div>
					<div className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">{model.id}</div>
					<span className="shrink-0 whitespace-nowrap rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
						{model.reasoning ? t("agent.modelThink") : t("agent.modelBase")}
					</span>
					<span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
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

function canClearProviderKey(provider: ProviderInfo): boolean {
	return provider.hasKey && (!provider.authSource || provider.authSource === "stored");
}

function providerTrack(provider: ProviderInfo, status: TestVerdict): string {
	if (status?.verdict === "ok") {
		return "bg-emerald-500";
	}
	if (status?.verdict === "error") {
		return "bg-rose-500";
	}
	if (status?.verdict === "skipped") {
		return "bg-amber-500";
	}
	if (!provider.hasKey) {
		return "bg-muted-foreground/35";
	}
	return "bg-emerald-500";
}

export default function ApiKeysTab({ providers, customStats, onProvidersChange }: ApiKeysTabProps) {
	const { t } = useTranslation();
	const [editing, setEditing] = useState<string | null>(null);
	const [keyInput, setKeyInput] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [saving, setSaving] = useState(false);
	const [loadingKey, setLoadingKey] = useState(false);
	const [testStatus, setTestStatus] = useState<Record<string, TestVerdict>>({});
	const [forceSave, setForceSave] = useState<ForceSaveState>(null);
	const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});
	const [expandedCustomProviders, setExpandedCustomProviders] = useState<Record<string, boolean>>({});

	const [customView, setCustomView] = useState<{ type: "list" } | { type: "form"; editing?: CustomProviderInput }>({
		type: "list",
	});
	const [customProviders, setCustomProviders] = useState<CustomProviderInput[]>([]);
	const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
	const [confirmClear, setConfirmClear] = useState<ProviderInfo | null>(null);

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

	const toggleCustomProviderExpand = (name: string) => {
		setExpandedCustomProviders((prev) => ({ ...prev, [name]: !prev[name] }));
	};

	const persistKey = async (providerId: string, key: string) => {
		if (!api) return false;
		try {
			const result = await api.setApiKey(providerId, key);
			if (result?.success) {
				onProvidersChange({ providers: result.providers, customStats: result.customStats });
				toast.success(
					key
						? t("settings.keyUpdated", { provider: providerId })
						: t("settings.keyRemoved", { provider: providerId }),
				);
				return true;
			}
			toast.error(result?.error ?? t("settings.selfTestFailed"));
		} catch (e: any) {
			toast.error(e?.message ?? t("settings.selfTestFailed"));
		}
		return false;
	};

	const closeEditor = () => {
		setSaving(false);
		setEditing(null);
		setKeyInput("");
		setShowKey(false);
		setLoadingKey(false);
		setForceSave(null);
	};

	const openEditor = async (provider: ProviderInfo) => {
		setEditing(provider.id);
		setShowKey(false);
		setForceSave(null);
		if (provider.hasKey && canClearProviderKey(provider) && api) {
			setLoadingKey(true);
			setKeyInput("");
			try {
				const r = await api.getApiKey(provider.id);
				if (r?.success && r.key) setKeyInput(r.key);
			} catch {
				/* leave empty */
			}
			setLoadingKey(false);
		} else {
			setKeyInput("");
		}
	};

	const handleSave = async () => {
		if (!editing || !api || !keyInput.trim()) return;
		const providerId = editing;
		const key = keyInput.trim();
		setSaving(true);
		setForceSave(null);
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
			if (await persistKey(providerId, key)) {
				setTestStatus((prev) => ({ ...prev, [providerId]: { verdict: "ok" } }));
				closeEditor();
			}
			return;
		}
		if (testResult.skipped) {
			if (await persistKey(providerId, key)) {
				setTestStatus((prev) => ({ ...prev, [providerId]: { verdict: "skipped", reason: testResult.reason } }));
				closeEditor();
			}
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
		setSaving(true);
		if (await persistKey(provider, key)) {
			setTestStatus((prev) => ({ ...prev, [provider]: { verdict: "error", reason } }));
			toast.warning(t("settings.failedSelfTest", { provider, reason }));
			closeEditor();
		}
	};

	const handleClearKey = async () => {
		if (!confirmClear) return;
		const providerId = confirmClear.id;
		if (await persistKey(providerId, "")) {
			setTestStatus((prev) => ({ ...prev, [providerId]: null }));
			if (editing === providerId) closeEditor();
		}
		setConfirmClear(null);
	};

	const allProviders = [...providers].sort((a, b) => (b.hasKey ? 1 : 0) - (a.hasKey ? 1 : 0));

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
				<div className="px-3 pt-3 pb-2">
					<h2 className="text-[13px] font-medium">{t("settings.apiKeys")}</h2>
					<p className="text-[11px] text-muted-foreground">{t("settings.apiKeysDescription")}</p>
				</div>
				<div className="flex flex-col gap-2 p-3 pt-0">
					<section className="rounded-lg border border-hairline bg-muted/20 p-2.5">
						<div className="flex items-center justify-between gap-3">
							<div className="min-w-0">
								<div className="flex items-center gap-2">
									<span className="text-[11px] font-medium text-foreground">
										{t("settings.customProviders.title")}
									</span>
									<Badge variant="outline" className="h-5 px-1.5 font-mono text-[10px]">
										{customProviders.length}
									</Badge>
									<span className="text-[10px] text-muted-foreground">
										{t("settings.customProviders.totalModels", { count: customStats.totalModels })}
									</span>
								</div>
								{customProviders.length === 0 && (
									<p className="mt-0.5 text-[10px] text-muted-foreground">
										{t("settings.customProviders.empty")}
									</p>
								)}
							</div>
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
						{customProviders.length > 0 && (
							<div className="mt-2 grid grid-cols-1 gap-1.5">
								{customProviders.map((cp) => {
									const isCustomExpanded = !!expandedCustomProviders[cp.name];
									const hasCustomModels = cp.models.length > 0;
									return (
										<div
											key={cp.name}
											className="group/custom-provider relative overflow-hidden rounded-md border border-hairline bg-background/35 transition-colors hover:bg-muted/40"
										>
											<div className="absolute left-0 top-0 h-full w-0.5 bg-emerald-500" />
											<div
												className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2 pl-4 pr-2.5"
												role="button"
												tabIndex={0}
												aria-expanded={isCustomExpanded}
												onClick={() => hasCustomModels && toggleCustomProviderExpand(cp.name)}
												onKeyDown={(e) => {
													if (!hasCustomModels) return;
													if (e.key === "Enter" || e.key === " ") {
														e.preventDefault();
														toggleCustomProviderExpand(cp.name);
													}
												}}
											>
												<div className="min-w-0">
													<div className="flex min-w-0 flex-wrap items-center gap-1.5">
														<ChevronRight
															className={cn(
																"size-3 shrink-0 text-muted-foreground transition-transform",
																isCustomExpanded && "rotate-90",
																!hasCustomModels && "opacity-30",
															)}
														/>
														<span className="min-w-0 truncate font-mono text-[12px] font-medium">
															{cp.name}
														</span>
														<Badge variant="outline" className="h-5 gap-1 px-1.5 font-mono text-[10px]">
															<Cpu className="size-2.5" />
															{cp.models.length}
														</Badge>
													</div>
													<div className="mt-0.5 truncate text-[10px] text-muted-foreground">{cp.api}</div>
												</div>
												<div
													className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/custom-provider:opacity-100 group-focus-within/custom-provider:opacity-100"
													onClick={(e) => e.stopPropagation()}
												>
													<Button
														variant="line"
														size="xs"
														className="h-6 text-[10px]"
														onClick={() => setCustomView({ type: "form", editing: cp })}
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

											{isCustomExpanded && hasCustomModels && (
												<ModelList
													models={cp.models.map((m) => ({
														id: m.id,
														name: m.name ?? m.id,
														reasoning: m.reasoning ?? false,
														contextWindow: m.contextWindow ?? 0,
														maxTokens: m.maxTokens ?? 0,
													}))}
													t={t}
												/>
											)}
										</div>
									);
								})}
							</div>
						)}
					</section>

					<div className="flex items-center justify-between border-b border-hairline px-1 pb-1">
						<span className="text-[11px] font-medium text-muted-foreground">{t("settings.providers.title")}</span>
						<span className="text-[10px] text-muted-foreground">
							{t("settings.providers.summary", {
								configured: allProviders.filter((p) => p.hasKey).length,
								total: allProviders.length,
							})}
						</span>
					</div>

					{allProviders.map((p) => {
						const isEditing = editing === p.id;
						const isExpanded = !!expandedProviders[p.id];
						const track = providerTrack(p, testStatus[p.id]);
						const hasModels = !!p.models?.length;
						const clearable = canClearProviderKey(p);
						const rowForceSave = forceSave?.provider === p.id ? forceSave : null;

						return (
							<div
								key={p.id}
								className={cn(
									"relative overflow-hidden rounded-md border border-hairline bg-muted/30 transition-colors",
									isEditing && "bg-muted/45 ring-1 ring-primary/45",
								)}
							>
								<div className={cn("absolute left-0 top-0 h-full w-0.5", track)} />
								<div
									className="group grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 pl-4"
									role="button"
									tabIndex={0}
									aria-expanded={isExpanded}
									onClick={() => hasModels && toggleProviderExpand(p.id)}
									onKeyDown={(e) => {
										if (!hasModels) return;
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											toggleProviderExpand(p.id);
										}
									}}
								>
									<div className="min-w-0">
										<div className="flex min-w-0 flex-wrap items-center gap-1.5">
											<ChevronRight
												className={cn(
													"size-3 shrink-0 text-muted-foreground transition-transform",
													isExpanded && "rotate-90",
													!hasModels && "opacity-30",
												)}
											/>
											<ProviderIcon id={p.id} className="size-4 shrink-0" />
											<span className="min-w-0 truncate text-[12px] font-medium">{p.name}</span>
											<ProviderModelCount provider={p} />
										</div>
									</div>
									<div
										className={cn(
											"flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
											isEditing && "opacity-100",
										)}
										onClick={(e) => e.stopPropagation()}
									>
										<Button
											variant={isEditing ? "line-filled" : "line"}
											size="xs"
											className="h-7 text-[10px]"
											onClick={() => (isEditing ? closeEditor() : openEditor(p))}
										>
											<Key data-icon="inline-start" className="size-3" />
											{isEditing
												? t("common.cancel")
												: p.hasKey
													? t("settings.replaceKey")
													: t("settings.addKey")}
										</Button>
										{clearable && !isEditing && (
											<Button
												variant="line-ghost"
												size="icon-xs"
												className="h-7 w-7 text-muted-foreground hover:text-destructive"
												onClick={() => setConfirmClear(p)}
											>
												<Trash2 className="size-3" />
											</Button>
										)}
									</div>
								</div>

								{isExpanded && p.models && p.models.length > 0 && <ModelList models={p.models} t={t} />}

								{isEditing && (
									<div className="border-t border-hairline bg-background/35 px-3 py-3 pl-4">
										<div className="flex items-start gap-2">
											<div className="relative min-w-0 flex-1">
												<Input
													type={showKey ? "text" : "password"}
													value={keyInput}
													onChange={(e) => {
														setKeyInput(e.target.value);
														setForceSave(null);
													}}
													onKeyDown={(e) => {
														if (e.key === "Enter") handleSave();
														if (e.key === "Escape") closeEditor();
													}}
													placeholder={loadingKey ? t("common.loading") : "sk-..."}
													autoFocus
													autoComplete="new-password"
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
												disabled={saving || loadingKey || !keyInput.trim()}
											>
												{saving ? (
													<>
														<Loader2 data-icon="inline-start" className="size-3 animate-spin" />
														{t("settings.testingKey")}
													</>
												) : (
													<>
														<ShieldCheck data-icon="inline-start" className="size-3" />
														{t("settings.testAndSaveKey")}
													</>
												)}
											</Button>
											<Button
												variant="line"
												size="sm"
												className="h-8 text-[11px]"
												onClick={closeEditor}
												disabled={saving}
											>
												{t("common.cancel")}
											</Button>
										</div>
										{p.envVar && (
											<p className="mt-1.5 text-[10px] text-muted-foreground">
												{t("settings.envKeyHint")}{" "}
												<code className="rounded bg-muted px-1 font-mono text-[10px]">
													export {p.envVar}=...
												</code>
											</p>
										)}
										{rowForceSave && (
											<div className="mt-2 rounded-md border border-rose-500/25 bg-rose-500/[0.04] p-2.5">
												<div className="flex items-center gap-1.5 text-[11px] font-medium text-rose-700 dark:text-rose-300">
													<AlertCircle className="size-3.5" />
													{t("settings.selfTestFailed")}
													{rowForceSave.status ? ` · HTTP ${rowForceSave.status}` : ""}
												</div>
												<p className="mt-1 font-mono text-[10px] text-rose-700/80 dark:text-rose-300/80">
													{rowForceSave.reason}
												</p>
												<div className="mt-2 flex items-center gap-2">
													<Button
														variant="line"
														size="xs"
														className="h-6 text-[10px]"
														onClick={handleSave}
														disabled={saving}
													>
														{t("settings.retryTest")}
													</Button>
													<Button
														variant="line-filled"
														size="xs"
														className="h-6 text-[10px]"
														onClick={handleForceSave}
														disabled={saving}
													>
														{t("settings.saveAnyway")}
													</Button>
												</div>
											</div>
										)}
									</div>
								)}
							</div>
						);
					})}
				</div>
			</div>

			<Dialog open={confirmClear !== null} onOpenChange={(o) => !o && setConfirmClear(null)}>
				<DialogContent className="sm:max-w-sm" showCloseButton={false}>
					<DialogHeader>
						<DialogTitle>{t("settings.confirmClear.title")}</DialogTitle>
						<DialogDescription>
							{t("settings.confirmClear.body", { provider: confirmClear?.name ?? "" })}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter className="gap-2">
						<Button variant="line" size="sm" onClick={() => setConfirmClear(null)}>
							{t("common.cancel")}
						</Button>
						<Button variant="line-filled" size="sm" onClick={handleClearKey}>
							{t("settings.clearKey")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

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
