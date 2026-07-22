// ============================================================
// SkillsPanel — Agent Skill 管理页面
//
// 搜索 + 内置/我的 Segment 切换 + Skill 卡片网格。
// ============================================================

import { Input } from "@shared/components/ui/input";
import { useAtom } from "jotai";
import { FolderOpen, Loader2, Search, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { agentSkillsAtom, agentSkillsLoadingAtom, skillSourceTabAtom } from "../../store/agentDefinitionsAtoms";
import { enabledSkillsAtom } from "../../store/atoms";
import SkillCard from "./SkillCard";
import { useToggleEnabled } from "./useToggleEnabled";

export default function SkillsPanel() {
	const { t } = useTranslation();
	const [skills, setSkills] = useAtom(agentSkillsAtom);
	const [loading, setLoading] = useAtom(agentSkillsLoadingAtom);
	const [sourceTab, setSourceTab] = useAtom(skillSourceTabAtom);
	const [searchText, setSearchText] = useState("");
	const [, setEnabledSkills] = useAtom(enabledSkillsAtom);

	const {
		isEnabled,
		toggle,
		setEnabledNames: loadEnabled,
	} = useToggleEnabled({
		getAllNames: useCallback(() => skills.map((s) => s.name), [skills]),
		setEnabled: useCallback(async (name: string, enabled: boolean) => window.look.setSkillEnabled(name, enabled), []),
		// 同步启用集合到全局 atom,供输入框 / 弹窗等跨组件读取
		onChange: useCallback((names: string[] | null) => setEnabledSkills(names), [setEnabledSkills]),
	});

	const loadSkills = useCallback(async () => {
		setLoading(true);
		try {
			const result = await window.look.listSkills();
			if (result?.success && Array.isArray(result.skills)) {
				setSkills(result.skills);
			} else {
				toast.error(result?.error ?? t("marketplace.loadSkillsFailed"));
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("marketplace.loadSkillsFailed"));
		} finally {
			setLoading(false);
		}
	}, [setSkills, setLoading, t]);

	useEffect(() => {
		loadSkills();
		loadEnabled();
	}, [loadSkills, loadEnabled]);

	const filteredSkills = useMemo(() => {
		let list = skills;
		if (sourceTab === "builtin") {
			list = list.filter((s) => s.category === "builtin");
		} else {
			list = list.filter((s) => s.category !== "builtin");
		}
		const term = searchText.trim().toLowerCase();
		if (term) {
			list = list.filter(
				(s) => (s.name ?? "").toLowerCase().includes(term) || (s.description ?? "").toLowerCase().includes(term),
			);
		}
		return list;
	}, [skills, sourceTab, searchText]);

	return (
		<div className="flex h-full flex-col gap-3">
			{/* 顶栏：搜索 */}
			<div className="relative">
				<Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
				<Input
					value={searchText}
					onChange={(e) => setSearchText(e.target.value)}
					placeholder={t("marketplace.searchSkills")}
					className="h-7 pl-7 pr-7 text-xs"
				/>
				{searchText && (
					<button
						type="button"
						onClick={() => setSearchText("")}
						className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
					>
						<X className="size-3" />
					</button>
				)}
			</div>

			{/* 内置/我的 Segment 切换 */}
			<div className="inline-flex items-center rounded-md p-0.5 border border-hairline bg-muted/20 w-fit">
				<button
					type="button"
					onClick={() => setSourceTab("builtin")}
					className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sm text-[11px] transition-colors ${
						sourceTab === "builtin"
							? "bg-background shadow-sm text-foreground font-medium"
							: "text-muted-foreground hover:text-foreground"
					}`}
				>
					<Sparkles className="size-3" />
					{t("marketplace.builtin")}
				</button>
				<button
					type="button"
					onClick={() => setSourceTab("mine")}
					className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sm text-[11px] transition-colors ${
						sourceTab === "mine"
							? "bg-background shadow-sm text-foreground font-medium"
							: "text-muted-foreground hover:text-foreground"
					}`}
				>
					<FolderOpen className="size-3" />
					{t("marketplace.mine")}
				</button>
			</div>

			{/* Skill 卡片网格 */}
			<div className="flex-1 overflow-y-auto">
				{loading ? (
					<div className="flex flex-col items-center justify-center py-12 gap-2">
						<Loader2 className="size-4 animate-spin text-muted-foreground" />
						<p className="text-xs text-muted-foreground">{t("marketplace.loading")}</p>
					</div>
				) : filteredSkills.length === 0 ? (
					<div className="flex flex-col items-center justify-center py-12 gap-2 text-xs text-muted-foreground">
						{searchText ? (
							<>
								<Search className="size-5 text-muted-foreground/40" />
								<p>{t("marketplace.noSkillMatch")}</p>
							</>
						) : sourceTab === "builtin" ? (
							<>
								<Sparkles className="size-5 text-muted-foreground/40" />
								<p>{t("marketplace.noBuiltinSkills")}</p>
							</>
						) : (
							<>
								<FolderOpen className="size-5 text-muted-foreground/40" />
								<p>{t("marketplace.noCustomSkills")}</p>
							</>
						)}
					</div>
				) : (
					<div className="grid grid-cols-2 gap-2">
						{filteredSkills.map((skill) => (
							<SkillCard
								key={skill.name}
								skill={skill}
								enabled={isEnabled(skill.name)}
								onToggle={(enabled) => toggle(skill.name, enabled)}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
