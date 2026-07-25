// ============================================================
// AgentCard — Agent 广场中的单个 Agent 卡片（Stage 3）
//
// 每个卡片带 Switch 开关，支持逐项启用/禁用。
// "我的"模块额外显示编辑/删除按钮（hover 可见）。
// 禁用状态的卡片整体 opacity-50 以视觉区分。
// ============================================================

import { Badge } from "@look/ui/components/ui/badge";
import { Button } from "@look/ui/components/ui/button";
import { Switch } from "@look/ui/components/ui/switch";
import type { AgentDefinitionInfo } from "@shared/types";
import { Pencil, Trash2 } from "lucide-react";
import { memo } from "react";
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

const CREATION_LABELS: Record<string, string> = {
	editor: "手动创建",
	skill: "Skill 创建",
	install: "从内置安装",
	drag: "文件导入",
	seed: "系统预置",
	unknown: "",
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
	return (
		<div
			tabIndex={0}
			onClick={() => onSelect(agent)}
			onKeyDown={(e) => {
				if (e.target !== e.currentTarget) return;
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onSelect(agent);
				}
			}}
			className={`group flex w-full cursor-pointer flex-col items-start gap-2 rounded-lg border p-3 text-left outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 ${
				selected
					? "border-accent bg-accent/10"
					: "border-hairline bg-card/40 hover:border-hairline hover:bg-accent/5"
			} ${!enabled ? "opacity-50 hover:opacity-70" : ""}`}
		>
			{/* 头像 + 名称 + 标签 + Switch */}
			<div className="flex w-full items-center gap-2">
				<AgentAvatar icon={agent.icon} />
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium">{agent.title || agent.name}</span>
				{agent.tags?.slice(0, 2).map((tag) => (
					<Badge key={tag} variant="secondary" className="h-4 shrink-0 px-1.5 text-[8px]">
						{tag}
					</Badge>
				))}
				{onToggle && (
					<Switch
						checked={enabled}
						onCheckedChange={(checked) => {
							onToggle(checked);
						}}
						onClick={(e) => e.stopPropagation()}
						className="scale-75 shrink-0"
					/>
				)}
			</div>

			{/* 描述 */}
			<p className="line-clamp-2 w-full text-[11px] leading-snug text-muted-foreground">{agent.description}</p>

			{/* 创建方式（仅用户 Agent 且非 unknown 时显示） */}
			{agent.source === "user" && agent.createdBy && agent.createdBy !== "unknown" && (
				<span className="text-[9px] text-muted-foreground/60">
					{CREATION_LABELS[agent.createdBy] ?? agent.createdBy}
				</span>
			)}

			{/* 模型 + 操作 */}
			<div className="flex w-full items-center gap-1.5 text-[10px] text-muted-foreground">
				{agent.model && (
					<span className="mr-auto truncate rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[9px]">
						{agent.model}
					</span>
				)}
				{/* 编辑/删除（仅 user 来源） */}
				{agent.source === "user" && (
					<div className="ml-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
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
		</div>
	);
});

export default AgentCard;
