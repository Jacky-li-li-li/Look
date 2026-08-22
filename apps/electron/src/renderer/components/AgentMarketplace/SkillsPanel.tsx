// ============================================================
// SkillsPanel — Agent Skill 管理页面
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import { Input } from "@look/ui/components/ui/input";
import { useAtom } from "jotai";
import { FolderOpen, Search, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { agentSkillsAtom, agentSkillsLoadingAtom, skillSourceTabAtom } from "../../store/agentDefinitionsAtoms";
import { enabledSkillsAtom } from "../../store/atoms";
import { WorkspaceEmptyState, WorkspaceLoadingState, WorkspaceSectionHeading } from "../workspace/WorkspacePageChrome";
import SkillCard from "./SkillCard";
import { useToggleEnabled } from "./useToggleEnabled";

export default function SkillsPanel() {
	const { t } = useTranslation();
	const [skills, setSkills] = useAtom(agentSkillsAtom);
	const [loading, setLoading] = useAtom(agentSkillsLoadingAtom);
	const [sourceTab, setSourceTab] = useAtom(skillSourceTabAtom);
	const [searchText, setSearchText] = useState("");
	const [, setEnabledSkills] = useAtom(enabledSkillsAtom);

	const { isEnabled, toggle, setEnabledNames } = useToggleEnabled({
		getAllNames: useCallback(() => skills.map((s) => s.name), [skills]),
		setEnabled: useCallback(async (name: string, enabled: boolean) => window.look.setSkillEnabled(name, enabled), []),
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

	const loadEnabled = useCallback(async () => {
		const result = await window.look.getGeneralSettings();
		if (result?.success) setEnabledNames(result.settings?.enabledSkills ?? null);
	}, [setEnabledNames]);

	useEffect(() => {
		void loadSkills();
		void loadEnabled();
	}, [loadSkills, loadEnabled]);

	const sourceFiltered = useMemo(
		() =>
			skills.filter((skill) =>
				sourceTab === "builtin" ? skill.category === "builtin" : skill.category !== "builtin",
			),
		[skills, sourceTab],
	);
	const filteredSkills = useMemo(() => {
		const term = searchText.trim().toLowerCase();
		if (!term) return sourceFiltered;
		return sourceFiltered.filter(
			(skill) =>
				(skill.name ?? "").toLowerCase().includes(term) || (skill.description ?? "").toLowerCase().includes(term),
		);
	}, [sourceFiltered, searchText]);

	const builtinCount = skills.filter((skill) => skill.category === "builtin").length;
	const mineCount = skills.length - builtinCount;
	const emptyTitle = searchText
		? t("marketplace.noSkillMatch")
		: sourceTab === "builtin"
			? t("marketplace.noBuiltinSkills")
			: t("marketplace.noCustomSkills");

	return (
		<div className="flex h-full min-h-0 flex-col gap-4">
			<WorkspaceSectionHeading icon={Sparkles} title={t("marketplace.skills")} count={filteredSkills.length} />

			<div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
				<div className="relative min-w-0 flex-1">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={searchText}
						onChange={(event) => setSearchText(event.target.value)}
						placeholder={t("marketplace.searchSkills")}
						className="h-8 pl-8 pr-8 text-xs"
					/>
					{searchText && (
						<button
							type="button"
							aria-label={t("marketplace.clearSearch")}
							onClick={() => setSearchText("")}
							className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						>
							<X className="size-3" />
						</button>
					)}
				</div>
				<div
					className="inline-flex w-fit items-center rounded-lg border border-hairline bg-muted/25 p-0.5"
					role="tablist"
				>
					<button
						type="button"
						role="tab"
						aria-selected={sourceTab === "builtin"}
						onClick={() => setSourceTab("builtin")}
						className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium transition-colors ${sourceTab === "builtin" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
					>
						<Sparkles className="size-3" />
						{t("marketplace.builtin")}
						<span className="tabular-nums text-[9px] text-muted-foreground/70">{builtinCount}</span>
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={sourceTab === "mine"}
						onClick={() => setSourceTab("mine")}
						className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium transition-colors ${sourceTab === "mine" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
					>
						<FolderOpen className="size-3" />
						{t("marketplace.mine")}
						<span className="tabular-nums text-[9px] text-muted-foreground/70">{mineCount}</span>
					</button>
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
				{loading ? (
					<WorkspaceLoadingState label={t("marketplace.loading")} />
				) : filteredSkills.length === 0 ? (
					<WorkspaceEmptyState
						icon={searchText ? Search : sourceTab === "builtin" ? Sparkles : FolderOpen}
						title={emptyTitle}
						description={searchText ? t("marketplace.clearSearch") : undefined}
						action={
							searchText ? (
								<Button variant="line" size="sm" onClick={() => setSearchText("")}>
									{t("marketplace.clearSearch")}
								</Button>
							) : undefined
						}
						className="min-h-[260px] rounded-xl border border-dashed border-hairline bg-muted/[0.08]"
					/>
				) : (
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
						{filteredSkills.map((skill) => (
							<SkillCard
								key={skill.name}
								skill={skill}
								enabled={isEnabled(skill.name)}
								onToggle={(enabled) => void toggle(skill.name, enabled)}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
