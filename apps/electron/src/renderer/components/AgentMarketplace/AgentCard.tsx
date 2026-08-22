// ============================================================
// AgentCard — Agent 广场中的单个 Agent 卡片
// ============================================================

import { Badge } from "@look/ui/components/ui/badge";
import { Button } from "@look/ui/components/ui/button";
import { Switch } from "@look/ui/components/ui/switch";
import type { AgentDefinitionInfo } from "@shared/types";
import { Pencil, Trash2 } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import AgentAvatar from "./AgentAvatar";

interface AgentCardProps {
	agent: AgentDefinitionInfo;
	selected: boolean;
	enabled?: boolean;
	onToggle?: (enabled: boolean) => void;
	onSelect: (agent: AgentDefinitionInfo) => void;
	onEdit: (agent: AgentDefinitionInfo) => void;
	onDelete: (agent: AgentDefinitionInfo) => void;
}

const CREATION_LABEL_KEYS: Record<string, string> = {
	editor: "marketplace.createdByEditor",
	skill: "marketplace.createdBySkill",
	install: "marketplace.createdByInstall",
	drag: "marketplace.createdByDrag",
	seed: "marketplace.createdBySeed",
};

const AgentCard = memo(function AgentCard({
	agent,
	selected,
	enabled = true,
	onToggle,
	onSelect,
	onEdit,
	onDelete,
}: AgentCardProps) {
	const { t } = useTranslation();
	return (
		<div
			tabIndex={0}
			role="button"
			aria-pressed={selected}
			aria-label={agent.title || agent.name}
			onClick={() => onSelect(agent)}
			onKeyDown={(event) => {
				if (event.target !== event.currentTarget) return;
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onSelect(agent);
				}
			}}
			className={`group flex min-h-[164px] w-full cursor-pointer flex-col gap-3 rounded-xl border p-3.5 text-left outline-none transition-[border-color,background-color,box-shadow,opacity] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 ${selected ? "border-primary/45 bg-primary/[0.08] shadow-[0_8px_22px_var(--selection-glow)]" : "border-hairline bg-card/40 hover:border-primary/25 hover:bg-card/65"} ${!enabled ? "opacity-55 hover:opacity-75" : ""}`}
		>
			<div className="flex w-full items-start gap-2.5">
				<AgentAvatar icon={agent.icon} className="size-8 shrink-0" />
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
							{agent.title || agent.name}
						</span>
						{onToggle && (
							<Switch
								size="sm"
								checked={enabled}
								aria-label={enabled ? t("marketplace.disableAgent") : t("marketplace.enableAgent")}
								onCheckedChange={onToggle}
								onClick={(event) => event.stopPropagation()}
							/>
						)}
					</div>
					<span className="mt-0.5 block truncate font-mono text-[9px] text-muted-foreground/60">
						/{agent.name}
					</span>
				</div>
			</div>

			{agent.tags && agent.tags.length > 0 && (
				<div className="flex min-h-5 flex-wrap gap-1">
					{agent.tags.slice(0, 3).map((tag) => (
						<Badge key={tag} variant="secondary" className="h-5 px-1.5 text-[9px]">
							{tag}
						</Badge>
					))}
				</div>
			)}

			<p className="line-clamp-3 min-h-[3.3rem] w-full text-[11px] leading-relaxed text-muted-foreground">
				{agent.description || t("marketplace.noDescription")}
			</p>

			<div className="mt-auto flex w-full items-center gap-1.5 text-[10px] text-muted-foreground">
				{agent.model && (
					<span className="min-w-0 max-w-[12rem] truncate rounded-md bg-muted/55 px-1.5 py-1 font-mono text-[9px]">
						{agent.model}
					</span>
				)}
				{agent.source === "user" && agent.createdBy && CREATION_LABEL_KEYS[agent.createdBy] && (
					<span className="ml-auto truncate text-[9px] text-muted-foreground/60">
						{t(CREATION_LABEL_KEYS[agent.createdBy])}
					</span>
				)}
				{agent.source === "user" && (
					<div className="ml-auto flex gap-0.5 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
						<Button
							variant="line-ghost"
							size="icon-xs"
							className="size-6"
							onClick={(event) => {
								event.stopPropagation();
								onEdit(agent);
							}}
							aria-label={t("marketplace.editAgent")}
							title={t("marketplace.editAgent")}
						>
							<Pencil className="size-3" />
						</Button>
						<Button
							variant="line-ghost"
							size="icon-xs"
							className="size-6 text-muted-foreground hover:text-destructive"
							onClick={(event) => {
								event.stopPropagation();
								onDelete(agent);
							}}
							aria-label={t("marketplace.deleteAgent")}
							title={t("marketplace.deleteAgent")}
						>
							<Trash2 className="size-3" />
						</Button>
					</div>
				)}
			</div>
		</div>
	);
});

export default AgentCard;
