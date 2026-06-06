// ============================================================
// ModelSelector — Centered dialog for picking a model (Ink Wash)
// ============================================================

import { Button } from "@shared/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@shared/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@shared/components/ui/tabs";
import type { AvailableModel } from "@shared/types";
import { ArrowRight, Check, ChevronDown, Cpu, Key, Terminal } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

const api = (window as any).look;

interface ModelSelectorProps {
	agentId: string;
	currentModel: string;
	onModelChanged?: (newModel: string) => void;
	/** Fired when the empty-state CTA asks to jump to API key settings. */
	onRequestApiKeys?: () => void;
}

type ProviderSource = "api" | "env";

interface ProviderLite {
	id: string;
	hasKey: boolean;
	authSource: string;
}

export default function ModelSelector({ agentId, currentModel, onModelChanged, onRequestApiKeys }: ModelSelectorProps) {
	const [models, setModels] = useState<AvailableModel[]>([]);
	const [providerSource, setProviderSource] = useState<Record<string, ProviderSource>>({});
	const [switching, setSwitching] = useState(false);
	const [verifiedEnv, setVerifiedEnv] = useState<Set<string>>(new Set());
	const [open, setOpen] = useState(false);
	const latestPropsRef = useRef({ currentModel, onModelChanged });
	latestPropsRef.current = { currentModel, onModelChanged };

	const fetchProvidersAndModels = useCallback(async () => {
		if (!api) return;
		const [m, p, v] = await Promise.all([api.getModels(), api.getProviders(), api.getVerifiedEnvProviders?.()]);
		if (m?.success) setModels(m.models);
		if (v?.success) setVerifiedEnv(new Set(v.providers));
		if (p?.success) {
			const map: Record<string, ProviderSource> = {};
			for (const prov of p.providers as ProviderLite[]) {
				if (prov.hasKey) {
					map[prov.id] = "api";
				} else if (prov.authSource && prov.authSource !== "fallback") {
					map[prov.id] = "env";
				}
			}
			setProviderSource(map);
		}
	}, []);

	// Fetch on mount
	useEffect(() => {
		fetchProvidersAndModels();
	}, [fetchProvidersAndModels]);

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
					toast.error(result?.error ?? "Failed to switch model");
				}
			} catch (err: any) {
				toast.error(err?.message ?? "Failed to switch model");
			} finally {
				setSwitching(false);
			}
		},
		[agentId],
	);

	const apiModels = models.filter((m) => providerSource[m.provider] === "api");
	const envModels = models.filter((m) => providerSource[m.provider] === "env" && verifiedEnv.has(m.provider));

	const currentModelObj = models.find((m) => `${m.provider}/${m.id}` === currentModel);
	const label = switching ? "…" : (currentModelObj?.name ?? currentModel?.split("/").pop() ?? "Model");

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				setOpen(o);
				if (o) fetchProvidersAndModels();
			}}
		>
			<DialogTrigger asChild>
				<Button variant="line" size="sm" className="group/selector h-7 max-w-40 font-mono text-[11px]">
					<Cpu data-icon="inline-start" className="size-3" />
					<span className="truncate">{label}</span>
					<ChevronDown
						data-icon="inline-end"
						className="size-3 transition-transform duration-150 group-data-[state=open]/selector:rotate-180"
					/>
				</Button>
			</DialogTrigger>
			<DialogContent className="max-w-xl p-0" showCloseButton>
				<DialogHeader className="px-4 pt-3 pb-0">
					<DialogTitle className="text-[13px] font-semibold">Switch model</DialogTitle>
				</DialogHeader>
				<div className="min-h-0">
					{models.length === 0 ? (
						<div className="px-4 py-8">
							<button
								type="button"
								onClick={onRequestApiKeys}
								className="group/empty flex w-full cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-[12px] outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
							>
								<span className="flex flex-col gap-0.5">
									<span className="font-medium text-foreground">配置第一个模型吧</span>
									<span className="text-[10px] text-muted-foreground">
										在 API Keys 里添加一个 provider 的 key 即可使用
									</span>
								</span>
								<ArrowRight className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-hover/empty:translate-x-0.5 group-hover/empty:text-foreground" />
							</button>
						</div>
					) : (
						<Tabs defaultValue="api" className="flex flex-col">
							<TabsList className="w-full shrink-0 rounded-none border-b border-t bg-transparent px-3">
								<TabsTrigger value="api" className="!h-auto !flex-none flex-1 gap-1.5 py-2 text-[11px]">
									<Key className="size-3" />
									API Keys
									{apiModels.length > 0 && (
										<span className="ml-auto rounded-full bg-muted-foreground/15 px-1.5 text-[9px] tabular-nums">
											{apiModels.length}
										</span>
									)}
								</TabsTrigger>
								<TabsTrigger value="env" className="!h-auto !flex-none flex-1 gap-1.5 py-2 text-[11px]">
									<Terminal className="size-3" />
									Environment
									{envModels.length > 0 && (
										<span className="ml-auto rounded-full bg-muted-foreground/15 px-1.5 text-[9px] tabular-nums">
											{envModels.length}
										</span>
									)}
								</TabsTrigger>
							</TabsList>
							<TabsContent value="api" className="max-h-80 overflow-y-auto p-2 data-[state=inactive]:hidden">
								<ModelList models={apiModels} currentModel={currentModel} onSwitch={handleSwitch} />
							</TabsContent>
							<TabsContent value="env" className="max-h-80 overflow-y-auto p-2 data-[state=inactive]:hidden">
								<ModelList models={envModels} currentModel={currentModel} onSwitch={handleSwitch} />
							</TabsContent>
						</Tabs>
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
}: {
	models: AvailableModel[];
	currentModel: string;
	onSwitch: (k: string) => void;
}) {
	if (models.length === 0) {
		return <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">No models in this category.</p>;
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
					<div className="px-3 pt-2 pb-0.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
						{provider}
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
										{m.reasoning ? "think" : "base"} / {(m.contextWindow / 1000).toFixed(0)}K
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
