// ============================================================
// CustomProvidersSection — custom provider list with add/edit/remove
// ============================================================

import { Badge } from "@look/ui/components/ui/badge";
import { Button } from "@look/ui/components/ui/button";
import { cn } from "@look/ui";
import { ChevronRight, Cpu, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CustomProviderInput, CustomProviderStats, ProviderModelInfo } from "./types";

function formatContextWindow(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
	}
	return `${Math.round(tokens / 1000)}K`;
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

function CustomProviderRow({
	cp,
	isExpanded,
	onToggleExpand,
	onEdit,
	onRemove,
}: {
	cp: CustomProviderInput;
	isExpanded: boolean;
	onToggleExpand: () => void;
	onEdit: () => void;
	onRemove: () => void;
}) {
	const { t } = useTranslation();
	const hasCustomModels = cp.models.length > 0;
	return (
		<div className="group/custom-provider relative overflow-hidden rounded-md border border-hairline bg-background/35 transition-colors hover:bg-muted/40">
			<div className="absolute left-0 top-0 h-full w-0.5 bg-emerald-500" />
			<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2 pl-4 pr-2.5">
				<button
					type="button"
					className={cn(
						"min-w-0 text-left bg-transparent border-0",
						hasCustomModels ? "cursor-pointer" : "cursor-default",
					)}
					aria-expanded={hasCustomModels ? isExpanded : undefined}
					disabled={!hasCustomModels}
					onClick={onToggleExpand}
				>
					<div className="flex min-w-0 flex-wrap items-center gap-1.5">
						<ChevronRight
							className={cn(
								"size-3 shrink-0 text-muted-foreground transition-transform",
								isExpanded && "rotate-90",
								!hasCustomModels && "opacity-30",
							)}
						/>
						<span className="min-w-0 truncate font-mono text-[12px] font-medium">{cp.name}</span>
						<Badge variant="outline" className="h-5 gap-1 px-1.5 font-mono text-[10px]">
							<Cpu className="size-2.5" />
							{cp.models.length}
						</Badge>
					</div>
					<div className="mt-0.5 truncate text-[10px] text-muted-foreground">{cp.api}</div>
				</button>
				<div
					className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/custom-provider:opacity-100"
					onClick={(e) => e.stopPropagation()}
				>
					<Button variant="line" size="xs" className="h-6 text-[10px]" onClick={onEdit}>
						{t("settings.customProviders.edit")}
					</Button>
					<Button
						variant="line-ghost"
						size="icon-xs"
						className="h-6 w-6 text-muted-foreground hover:text-destructive"
						onClick={onRemove}
					>
						<Trash2 className="size-3" />
					</Button>
				</div>
			</div>

			{isExpanded && hasCustomModels && (
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
}

interface CustomProvidersSectionProps {
	customProviders: CustomProviderInput[];
	expanded: Record<string, boolean>;
	customStats: CustomProviderStats;
	onToggleExpand: (name: string) => void;
	onEdit: (cp: CustomProviderInput) => void;
	onRemove: (name: string) => void;
	onAdd: () => void;
}

export default function CustomProvidersSection({
	customProviders,
	expanded,
	customStats,
	onToggleExpand,
	onEdit,
	onRemove,
	onAdd,
}: CustomProvidersSectionProps) {
	const { t } = useTranslation();

	return (
		<section>
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="text-[11px] font-medium text-foreground">{t("settings.customProviders.title")}</span>
						<Badge variant="outline" className="h-5 px-1.5 font-mono text-[10px]">
							{customProviders.length}
						</Badge>
						<span className="text-[10px] text-muted-foreground">
							{t("settings.customProviders.totalModels", { count: customStats.totalModels })}
						</span>
					</div>
					{customProviders.length === 0 && (
						<p className="mt-0.5 text-[10px] text-muted-foreground">{t("settings.customProviders.empty")}</p>
					)}
				</div>
				<Button variant="line" size="xs" className="h-7 text-[10px]" onClick={onAdd}>
					<Plus className="size-3" data-icon="inline-start" />
					{t("settings.customProviders.addButton")}
				</Button>
			</div>
			{customProviders.length > 0 && (
				<div className="mt-2 grid grid-cols-1 gap-1.5">
					{customProviders.map((cp) => {
						const isExpanded = !!expanded[cp.name];
						return (
							<CustomProviderRow
								key={cp.name}
								cp={cp}
								isExpanded={isExpanded}
								onToggleExpand={() => onToggleExpand(cp.name)}
								onEdit={() => onEdit(cp)}
								onRemove={() => onRemove(cp.name)}
							/>
						);
					})}
				</div>
			)}
		</section>
	);
}
