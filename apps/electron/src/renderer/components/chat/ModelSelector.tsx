// ============================================================
// ModelSelector — Centered dialog for picking a model (Ink Wash)
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@look/ui/components/ui/dialog";
import type { AvailableModel } from "@shared/types";
import { useAtomValue } from "jotai";
import { ArrowRight, Check, ChevronDown, Loader2, Search } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { modelUpdatedVersionAtom } from "../../store/settingsAtoms";
import { ProviderIcon } from "../ProviderIcon";

const api = window.look;

/**
 * 模型目录缓存提升到模块级：ChatPanel 以 agentId 为 key 重挂载（新建会话、
 * 切换会话都会），组件级 ref 会在重挂载时清空并重新异步拉取目录，导致模型行
 * 首帧只显示 model key、目录到达后才换成完整名称——输入框看起来在跳动。
 * 模块级缓存让每次挂载首帧就能命中完整名称；主进程刷新模型时
 * modelUpdatedVersionAtom 递增，所有挂载实例都会失效一次。
 */
const MODELS_CACHE_TTL_MS = 60_000;
const modelsCache: { models: AvailableModel[]; ts: number; version: number } = {
	models: [],
	ts: 0,
	version: 0,
};

interface ModelSelectorProps {
	agentId: string;
	currentModel: string;
	onModelChanged?: (newModel: string) => void;
	/** Fired when the empty-state CTA asks to jump to API key settings. */
	onRequestApiKeys?: () => void;
}

export default function ModelSelector({ agentId, currentModel, onModelChanged, onRequestApiKeys }: ModelSelectorProps) {
	const { t } = useTranslation();
	// 用模块级缓存初始化：新建/切换会话重挂载时首帧就有完整目录，模型行立即显示
	// 完整名称；effect 里的 fetchModels 只是再确认新鲜度（命中缓存时 setModels 同值）。
	const [models, setModels] = useState<AvailableModel[]>(() => modelsCache.models);
	const [switching, setSwitching] = useState(false);
	const [open, setOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const searchInputRef = useRef<HTMLInputElement>(null);
	const latestPropsRef = useRef({ currentModel, onModelChanged });
	latestPropsRef.current = { currentModel, onModelChanged };

	// 主进程刷新模型（API key 设置、OAuth 登录等）→ version 递增 → 全局失效缓存，
	// 下一次打开对话框强制拉取。用模块级 version 而不是组件 ref：跨挂载（新建会话 /
	// 切换会话时 ChatPanel 以 agentId 为 key 重挂载）仍能感知，不会把过期目录当新的。
	const modelVersion = useAtomValue(modelUpdatedVersionAtom);
	if (modelVersion !== modelsCache.version) {
		modelsCache.models = [];
		modelsCache.ts = 0;
		modelsCache.version = modelVersion;
	}

	const fetchModels = useCallback(async (force = false) => {
		if (!api) return;
		const now = Date.now();
		// Return cached if fresh (< 60s) and not forced
		if (!force && modelsCache.ts > 0 && now - modelsCache.ts < MODELS_CACHE_TTL_MS) {
			setModels(modelsCache.models);
			return;
		}
		const m = await api.getModels();
		if (m?.success) {
			modelsCache.models = m.models;
			modelsCache.ts = now;
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
	// Keep the last valid catalog entry while the model list is refreshing. The
	// fallback key is still rendered when the selected model changes, so a stale
	// model name can never be shown for a different session/model.
	const stableModelRef = useRef<{ key: string; model: AvailableModel } | null>(null);
	if (currentModelObj) {
		stableModelRef.current = { key: currentModel, model: currentModelObj };
	} else if (stableModelRef.current?.key !== currentModel) {
		stableModelRef.current = null;
	}
	const displayModelObj = currentModelObj ?? stableModelRef.current?.model;
	const fallbackModelLabel = currentModel?.split("/").pop() || t("agent.model");
	// 切换中不换文案（避免按钮宽度一缩一放的抖动），只把图标换成 spinner。
	// 模型目录异步到达前也用 currentModel 的稳定 key 占位；工具栏槽位固定且
	// 可收缩，首帧不会出现空白/整行横向重排。
	const label = displayModelObj?.name ?? fallbackModelLabel;

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
				<Button
					variant="line-ghost"
					size="sm"
					className="group/selector h-7 min-w-[5.5rem] max-w-[9rem] flex-[0_1_8rem] justify-start overflow-hidden font-mono text-[11px]"
					aria-label={label}
					title={label}
					disabled={switching}
				>
					{switching ? (
						<Loader2 className="size-3 shrink-0 animate-spin" data-icon="inline-start" />
					) : (
						<ProviderIcon
							id={displayModelObj?.provider ?? currentModel?.split("/")[0] ?? ""}
							className="size-3 shrink-0"
							data-icon="inline-start"
						/>
					)}
					<span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">{label}</span>
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
							aria-label={t("agent.searchModels", "Search models")}
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
							<ModelList
								models={filteredModels}
								currentModel={currentModel}
								onSwitch={handleSwitch}
								expandAll={searchQuery.trim().length > 0}
								t={t}
							/>
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
	expandAll,
	t,
}: {
	models: AvailableModel[];
	currentModel: string;
	onSwitch: (k: string) => void;
	/** 搜索时强制展开全部分组，让匹配结果直接可见 */
	expandAll: boolean;
	t: (key: string) => string;
}) {
	const grouped: Record<string, AvailableModel[]> = {};
	for (const m of models) {
		if (!grouped[m.provider]) grouped[m.provider] = [];
		grouped[m.provider].push(m);
	}
	// 默认折叠全部分组，只展开当前模型所在 provider；弹窗随 Dialog
	// 卸载重建，useState 初始值每次打开都会重算。
	const activeProvider = models.find((m) => `${m.provider}/${m.id}` === currentModel)?.provider;
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(activeProvider ? [activeProvider] : []));

	if (models.length === 0) {
		return <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">{t("agent.noModelsCategory")}</p>;
	}

	const toggle = (provider: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(provider)) next.delete(provider);
			else next.add(provider);
			return next;
		});

	return (
		<>
			{Object.entries(grouped).map(([provider, pModels], index, entries) => {
				const isOpen = expandAll || expanded.has(provider);
				const hasActive = pModels.some((m) => `${m.provider}/${m.id}` === currentModel);
				return (
					<React.Fragment key={provider}>
						<button
							type="button"
							onClick={() => toggle(provider)}
							aria-expanded={isOpen}
							className="flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-left text-[11px] font-medium uppercase tracking-widest text-muted-foreground outline-hidden transition-colors hover:text-foreground focus-visible:text-foreground"
						>
							<ProviderIcon id={provider} className="size-3" />
							<span>{provider}</span>
							<span className="font-mono tracking-normal text-muted-foreground/50">{pModels.length}</span>
							{!isOpen && hasActive && <Check className="size-3 text-foreground" />}
							<ChevronDown
								className={`ml-auto size-3 shrink-0 transition-transform duration-150 ${isOpen ? "" : "-rotate-90"}`}
							/>
						</button>
						{isOpen && (
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
											className="flex w-full cursor-pointer items-center rounded-md px-3 py-1.5 text-left text-[12px] outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:cursor-default"
										>
											{/* 当前模型：书签线压行首，不用 ✓ */}
											<span
												className={`mr-2 h-3.5 w-0.5 shrink-0 rounded-full ${isActive ? "bg-foreground" : ""}`}
											/>
											<span className={isActive ? "font-semibold" : ""}>{m.name}</span>
											<span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
												{m.reasoning ? t("agent.modelThink") : t("agent.modelBase")} /{" "}
												{(m.contextWindow / 1000).toFixed(0)}K
											</span>
										</button>
									);
								})}
							</div>
						)}
						{index < entries.length - 1 && <div className="-mx-1 my-1 h-px bg-border" />}
					</React.Fragment>
				);
			})}
		</>
	);
}
