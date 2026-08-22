// ============================================================
// SkillCard — Agent Skill 页面中的单个 Skill 卡片
// ============================================================

import { Switch } from "@look/ui/components/ui/switch";
import { Sparkles } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";

interface SkillCardProps {
	skill: {
		name: string;
		description: string;
		category?: "builtin" | "mine";
	};
	enabled: boolean;
	onToggle: (enabled: boolean) => void;
}

const SkillCard = memo(function SkillCard({ skill, enabled, onToggle }: SkillCardProps) {
	const { t } = useTranslation();
	return (
		<div
			className={`flex min-h-[142px] w-full flex-col gap-3 rounded-xl border p-3.5 text-left transition-[border-color,background-color,opacity] ${enabled ? "border-hairline bg-card/40 hover:border-primary/25 hover:bg-card/65" : "border-hairline bg-card/25 opacity-55 hover:opacity-75"}`}
		>
			<div className="flex w-full items-start gap-2.5">
				<span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
					<Sparkles className="size-4" />
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex items-start justify-between gap-2">
						<span className="min-w-0 truncate text-[13px] font-semibold text-foreground">{skill.name}</span>
						<Switch
							size="sm"
							checked={enabled}
							aria-label={enabled ? t("marketplace.disableSkill") : t("marketplace.enableSkill")}
							onCheckedChange={onToggle}
						/>
					</div>
					<span className="mt-0.5 block text-[9px] text-muted-foreground/60">
						{skill.category === "builtin" ? t("marketplace.builtin") : t("marketplace.mine")}
					</span>
				</div>
			</div>

			<p className="line-clamp-4 min-h-[4.2rem] w-full text-[11px] leading-relaxed text-muted-foreground">
				{skill.description || t("marketplace.noDescription")}
			</p>
		</div>
	);
});

export default SkillCard;
