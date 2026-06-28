// ============================================================
// AgentCard — Agent 广场中的单个 Agent 卡片（Stage 3）
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Button } from "@shared/components/ui/button";
import type { AgentDefinitionInfo } from "@shared/types";
import { Pencil, Trash2 } from "lucide-react";
import { memo } from "react";

interface AgentCardProps {
	agent: AgentDefinitionInfo;
	selected: boolean;
	onSelect: (agent: AgentDefinitionInfo) => void;
	onEdit: (agent: AgentDefinitionInfo) => void;
	onDelete: (agent: AgentDefinitionInfo) => void;
}

const SOURCE_COLORS: Record<string, string> = {
	user: "text-amber-500 border-amber-500/30",
	project: "text-sky-500 border-sky-500/30",
	marketplace: "text-emerald-500 border-emerald-500/30",
};

const SOURCE_LABELS: Record<string, string> = {
	user: "用户",
	project: "项目",
	marketplace: "广场",
};

const AgentCard = memo(function AgentCard({ agent, selected, onSelect, onEdit, onDelete }: AgentCardProps) {
	return (
		<button
			type="button"
			onClick={() => onSelect(agent)}
			className={`group flex w-full flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors ${
				selected
					? "border-accent bg-accent/10"
					: "border-hairline bg-card/40 hover:border-hairline hover:bg-accent/5"
			}`}
		>
			{/* 图标 + 名称 + 来源 */}
			<div className="flex w-full items-center gap-2">
				<span className="text-lg leading-none" aria-hidden>
					{agent.icon ?? "🤖"}
				</span>
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium">{agent.title || agent.name}</span>
				<Badge variant="outline" className={`h-4 shrink-0 px-1.5 text-[9px] ${SOURCE_COLORS[agent.source] ?? ""}`}>
					{SOURCE_LABELS[agent.source] ?? agent.source}
				</Badge>
			</div>

			{/* 描述 */}
			<p className="line-clamp-2 w-full text-[11px] leading-snug text-muted-foreground">{agent.description}</p>

			{/* 模型 + 标签 + 操作 */}
			<div className="flex w-full items-center gap-1.5 text-[10px] text-muted-foreground">
				{agent.model && (
					<span className="mr-auto truncate rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[9px]">
						{agent.model}
					</span>
				)}
				{agent.tags?.slice(0, 2).map((tag) => (
					<Badge key={tag} variant="secondary" className="h-4 px-1.5 text-[8px]">
						{tag}
					</Badge>
				))}
				{agent.source === "user" && (
					<div className="ml-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
						<Button
							variant="ghost"
							size="icon-sm"
							className="size-5"
							onClick={(e) => {
								e.stopPropagation();
								onEdit(agent);
							}}
							aria-label="编辑"
							title="编辑 Agent"
						>
							<Pencil className="size-3" />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							className="size-5 text-muted-foreground hover:text-destructive"
							onClick={(e) => {
								e.stopPropagation();
								onDelete(agent);
							}}
							aria-label="删除"
							title="删除 Agent"
						>
							<Trash2 className="size-3" />
						</Button>
					</div>
				)}
			</div>
		</button>
	);
});

export default AgentCard;
