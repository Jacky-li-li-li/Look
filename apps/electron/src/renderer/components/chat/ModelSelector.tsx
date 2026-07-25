// ============================================================
// ModelSelector — Centered dialog for picking a model (Ink Wash)
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@look/ui/components/ui/dialog";
import type { AvailableModel } from "@shared/types";
import { ArrowRight, Check, Search } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ProviderIcon } from "../ProviderIcon";

const api = window.look;

interface ModelSelectorProps {
	agentId: string;
	currentModel: string;
	onModelChanged?: (newModel: string) => void;
	/** Fired when the empty-state CTA asks to jump to API key settings. */
	onRequestApiKeys?: () => void;
}

export default function ModelSelector({ agentId, currentModel, onModelChanged, onRequestApiKeys }: ModelSelectorProps) {
	const { t } = useTranslation();
	const [models, setModels] = useState<AvailableModel[]>([]);
	const [switching, setSwitching] = useState(false);
	const [open, setOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const searchInputRef = useRef<HTMLInputElement>(null);
	const latestPropsRef = useRef({ currentModel, onModelChanged });
	latestPropsRef.current = { currentModel, onModelChanged };

	// Cache: avoid re-fetching on every dialog open (ref persists across renders)
	const modelsCacheRef = useRef<{ models: AvailableModel[]; ts: number }>({ models: [], ts: 0 });

	const fetchModels = useCallback(async (force = false) => {
		if (!api) return;
		const now = Date.now();
		// Return cached if fresh (< 60s) and not forced
		if (!force && modelsCacheRef.current.ts > 0 && now - modelsCacheRef.current.ts < 60_000) {
			setModels(modelsCacheRef.current.models);
			return;
		}
		const m = await api.getModels();
		if (m?.success) {
			modelsCacheRef.current = { models: m.models, ts: now };
			setModels(m.models);
		}
	}, []);

	// Fuzzy-filter models by search query (case-insensitive substring match)
	const filteredModels = useMemo(() => {
		if (!searchQuery.trim()) return models;
		const q = searchQuery.toLowerCase();
		return models.filter(
			(m) =>
				m.name.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
		);
	}, [models, searchQuery]);

	// Fetch on mount
	useEffect(() => {
		fetchModels();
	}, [fetchModels]);

	const handleSwitch = useCallback(
		async (modelKey: string) => {
			// Snapshot the agent we're switching *now*. The user can
			// switch agents mid-flight: ChatPanel passes a new
			// `agentId` prop when the active agent changes, and the
			// `onModelChanged` callback we close over is bound to
			// *that* new agent's state. Without this snapshot, the
			// awaiting handler would fire `onChange` against the
			// wrong agent after the user clicked away.
			const targetAgentId = agentId;
			const { currentModel: cur, onModelChanged: onChange } = latestPropsRef.current;
			if (modelKey === cur) return;
			setSwitching(true);
			try {
				// react-doctor-disable-next-line async-defer-await -- 切换模型后需重新检查 agent 是否已变更
				const result = await api.switchModel(targetAgentId, modelKey);
				// Re-check at the top of the callback: if the user
				// switched agents *during* the await, the `onChange`
				// in the ref now belongs to a different agent and
				// calling it would clobber that agent's state. Skip
				// the notification — the new agent's selector is
				// already showing the right model via the
				// `agent:updated` event from main.
				if (latestPropsRef.current.onModelChanged !== onChange) return;
				if (result?.success) {
					onChange?.(modelKey);
					setOpen(false);
				} else {
					toast.error(result?.error ?? t("toast.modelSwitchFailed"));
				}
			} catch (err) {
				toast.error(err instanceof Error ? err.message : t("toast.modelSwitchFailed"));
			} finally {
				setSwitching(false);
			}
		},
		[agentId, t],
	);

	const currentModelObj = models.find((m) => `${m.provider}/${m.id}` === currentModel);
	const label = switching ? "…" : (currentModelObj?.name ?? currentModel?.split("/").pop() ?? t("agent.model"));

	// Default the active tab to whichever side has content. If the
	// user only configured env-var credentials, the "API Keys" tab
	// would otherwise open to an empty list and the user would think
	// the dialog is broken. Re-evaluated each time the data refreshes
	// (key forces remount when the loaded-model count changes).

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				setOpen(o);
				if (o) {
					fetchModels();
					setSearchQuery("");
					// Auto-focus search input after dialog animation
					setTimeout(() => searchInputRef.current?.focus(), 100);
				}
			}}
		>
			<DialogTrigger asChild>
				<Button variant="line-ghost" size="sm" className="group/selector h-7 font-mono text-[11px]" title={label}>
					<ProviderIcon
						id={currentModelObj?.provider ?? currentModel?.split("/")[0] ?? ""}
						className="size-3"
						data-icon="inline-start"
					/>
					<span className="whitespace-nowrap">{label}</span>
				</Button>
			</DialogTrigger>
			<DialogContent className="max-w-xl p-0 max-h-[85vh] overflow-hidden grid-rows-[auto_auto_1fr]" showCloseButton>
				<DialogHeader className="px-4 pt-3 pb-0">
					<DialogTitle className="text-[13px] font-semibold">{t("agent.switchModel")}</DialogTitle>
				</DialogHeader>
				<div className="px-4 pb-2">
					<div className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5">
						<Search className="size-3.5 shrink-0 text-muted-foreground" />
						<input
							ref={searchInputRef}
							type="text"
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							placeholder={t("agent.searchModels", "Search models…")}
							className="flex-1 bg-transparent text-[12px] outline-hidden placeholder:text-muted-foreground"
						/>
					</div>
				</div>
				<div className="min-h-0 overflow-y-auto">
					{models.length === 0 ? (
						<div className="px-4 py-8">
							<button
								type="button"
								onClick={onRequestApiKeys}
								className="group/empty flex w-full cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-[12px] outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
							>
								<span className="flex flex-col gap-0.5">
									<span className="font-medium text-foreground">{t("toast.configFirstModel")}</span>
									<span className="text-[10px] text-muted-foreground">{t("toast.configFirstModelDesc")}</span>
								</span>
								<ArrowRight className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-hover/empty:translate-x-0.5 group-hover/empty:text-foreground" />
							</button>
						</div>
					) : searchQuery.trim() && filteredModels.length === 0 ? (
						<p className="px-4 py-8 text-center text-[12px] text-muted-foreground">{`No models matching "${searchQuery}"`}</p>
					) : (
						<div className="p-2">
							<ModelList models={filteredModels} currentModel={currentModel} onSwitch={handleSwitch} t={t} />
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function ModelList({
	models,
	currentModel,
	onSwitch,
	t,
}: {
	models: AvailableModel[];
	currentModel: string;
	onSwitch: (k: string) => void;
	t: (key: string) => string;
}) {
	if (models.length === 0) {
		return <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">{t("agent.noModelsCategory")}</p>;
	}
	const grouped: Record<string, AvailableModel[]> = {};
	for (const m of models) {
		if (!grouped[m.provider]) grouped[m.provider] = [];
		grouped[m.provider].push(m);
	}
	return (
		<>
			{Object.entries(grouped).map(([provider, pModels], index, entries) => (
				<React.Fragment key={provider}>
					<div className="flex items-center gap-1.5 px-3 pt-2 pb-0.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
						<ProviderIcon id={provider} className="size-3" />
						<span>{provider}</span>
					</div>
					<div>
						{pModels.map((m) => {
							const mk = `${m.provider}/${m.id}`;
							const isActive = mk === currentModel;
							return (
								<button
									key={mk}
									type="button"
									disabled={isActive}
									onClick={() => onSwitch(mk)}
									className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-1.5 text-left text-[12px] outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:cursor-default disabled:opacity-50"
								>
									<span className={isActive ? "font-semibold" : ""}>
										{m.name}
										{isActive && <Check className="ml-1 inline size-3" />}
									</span>
									<span className="shrink-0 font-mono text-[10px] text-muted-foreground">
										{m.reasoning ? t("agent.modelThink") : t("agent.modelBase")} /{" "}
										{(m.contextWindow / 1000).toFixed(0)}K
									</span>
								</button>
							);
						})}
					</div>
					{index < entries.length - 1 && <div className="-mx-1 my-1 h-px bg-border" />}
				</React.Fragment>
			))}
		</>
	);
}
