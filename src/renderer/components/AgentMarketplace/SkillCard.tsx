// ============================================================
// SkillCard — Agent Skill 页面中的单个 Skill 卡片
//
// 两行布局：Row1=图标+名称+来源+Switch，Row2=描述。
// 充分利用卡片纵向空间，与 AgentCard 视觉密度对齐。
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Switch } from "@shared/components/ui/switch";
import { Sparkles } from "lucide-react";
import { memo } from "react";

interface SkillCardProps {
	skill: {
		name: string;
		description: string;
		category?: "builtin" | "mine";
	};
	enabled: boolean;
	onToggle: (enabled: boolean) => void;
}

const CATEGORY_COLORS: Record<string, string> = {
	builtin: "text-emerald-500 border-emerald-500/30",
	mine: "text-amber-500 border-amber-500/30",
};

const CATEGORY_LABELS: Record<string, string> = {
	builtin: "内置",
	mine: "我的",
};

const SkillCard = memo(function SkillCard({ skill, enabled, onToggle }: SkillCardProps) {
	const category = skill.category ?? "mine";
	return (
		<div
			className={`flex w-full flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors border-hairline bg-card/40 hover:bg-accent/5 ${
				!enabled ? "opacity-50 hover:opacity-70" : ""
			}`}
		>
			{/* Row 1: 图标 + 名称 + 来源 Badge + Switch */}
			<div className="flex w-full items-center gap-2">
				<Sparkles className="size-5 shrink-0 text-foreground" />
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium">{skill.name}</span>
				<Badge variant="outline" className={`h-4 shrink-0 px-1.5 text-[9px] ${CATEGORY_COLORS[category] ?? ""}`}>
					{CATEGORY_LABELS[category] ?? category}
				</Badge>
				<Switch
					checked={enabled}
					onCheckedChange={onToggle}
					className="scale-75 shrink-0"
				/>
			</div>

			{/* Row 2: 描述 */}
			<p className="line-clamp-2 w-full text-[11px] leading-snug text-muted-foreground">
				{skill.description || "暂无描述"}
			</p>
		</div>
	);
});

export default SkillCard;
