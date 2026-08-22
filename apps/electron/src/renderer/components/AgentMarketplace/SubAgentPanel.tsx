// ============================================================
// SubAgentPanel — SubAgent 管理页面
//
// 搜索 + 来源筛选 + Agent 卡片网格。每张卡片带 Switch 开关，
// 选中卡片时在工具栏下方显示轻量详情，避免点击后只留下无意义的边框。
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import { Input } from "@look/ui/components/ui/input";
import { type AgentDefinitionInfo, DEFAULT_PROJECT_ID } from "@shared/types";
import { useAtom } from "jotai";
import { Bot, Search, Sparkles, User, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAgentActions } from "../../hooks/useAgentActions";
import {
	agentDefinitionsAtom,
	agentDefinitionsLoadingAtom,
	agentEditorTargetAtom,
	agentSearchTextAtom,
	subagentSourceTabAtom,
} from "../../store/agentDefinitionsAtoms";
import { appStore } from "../../store/appStore";
import { chatInputInsertRequestAtom, enabledAgentDefinitionsAtom } from "../../store/atoms";
import { navigateMainView } from "../../store/viewNavigation";
import { WorkspaceEmptyState, WorkspaceLoadingState, WorkspaceSectionHeading } from "../workspace/WorkspacePageChrome";
import AgentAvatar from "./AgentAvatar";
import AgentCard from "./AgentCard";
import AgentEditor from "./AgentEditor";
import { useToggleEnabled } from "./useToggleEnabled";

export default function SubAgentPanel() {
	const { t } = useTranslation();
	const [agents, setAgents] = useAtom(agentDefinitionsAtom);
	const [editorTarget, setEditorTarget] = useAtom(agentEditorTargetAtom);
	const [searchText, setSearchText] = useAtom(agentSearchTextAtom);
	const [loading, setLoading] = useAtom(agentDefinitionsLoadingAtom);
	const [sourceTab, setSourceTab] = useAtom(subagentSourceTabAtom);
	const [selected, setSelected] = useState<AgentDefinitionInfo | null>(null);
	const [, setEnabledAgentDefs] = useAtom(enabledAgentDefinitionsAtom);

	const { isEnabled, toggle, setEnabledNames } = useToggleEnabled({
		getAllNames: useCallback(() => agents.map((a) => a.name), [agents]),
		setEnabled: useCallback(
			async (name: string, enabled: boolean) => window.look.setAgentDefinitionEnabled(name, enabled),
			[],
		),
		onChange: useCallback((names: string[] | null) => setEnabledAgentDefs(names), [setEnabledAgentDefs]),
	});

	const loadAgents = useCallback(async () => {
		setLoading(true);
		try {
			const result = await window.look.listAgentDefinitions();
			if (result?.success && Array.isArray(result.agents)) {
				setAgents(result.agents);
			} else {
				toast.error(result?.error ?? t("marketplace.loadAgentsFailed"));
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("marketplace.loadAgentsFailed"));
		} finally {
			setLoading(false);
		}
	}, [setAgents, setLoading, t]);

	const loadEnabled = useCallback(async () => {
		const result = await window.look.getGeneralSettings();
		if (result?.success) setEnabledNames(result.settings?.enabledAgentDefinitions ?? null);
	}, [setEnabledNames]);

	useEffect(() => {
		void loadAgents();
		void loadEnabled();
	}, [loadAgents, loadEnabled]);

	const sourceFiltered = useMemo(() => {
		if (sourceTab === "builtin") return agents.filter((a) => a.source === "builtin");
		return agents.filter((a) => a.source === "user" || a.source === "project");
	}, [agents, sourceTab]);

	const filteredAgents = useMemo(() => {
		const term = searchText.trim().toLowerCase();
		if (!term) return sourceFiltered;
		return sourceFiltered.filter(
			(a) =>
				a.name.toLowerCase().includes(term) ||
				(a.title ?? "").toLowerCase().includes(term) ||
				a.description.toLowerCase().includes(term),
		);
	}, [sourceFiltered, searchText]);

	const handleSaved = useCallback(
		(saved: AgentDefinitionInfo) => {
			setAgents((prev) => {
				const idx = prev.findIndex((a) => a.name === saved.name);
				if (idx >= 0) {
					const next = [...prev];
					next[idx] = saved;
					return next;
				}
				return [...prev, saved];
			});
			setSelected(saved);
		},
		[setAgents],
	);

	const { handleCreateClick } = useAgentActions();

	const handleAiCreate = useCallback(async () => {
		navigateMainView("chat");
		try {
			await window.look.switchProject(DEFAULT_PROJECT_ID);
			const agentId = await handleCreateClick(DEFAULT_PROJECT_ID);
			if (!agentId) {
				toast.error(t("marketplace.aiCreateFailed"));
				return;
			}
			appStore.set(chatInputInsertRequestAtom, {
				id: Date.now(),
				agentId,
				text: "/skill:look-agent-builder",
			});
		} catch {
			toast.error(t("marketplace.aiCreateFailed"));
		}
	}, [handleCreateClick, t]);

	const deleteAgent = useCallback(
		(agent: AgentDefinitionInfo) => {
			if (!window.confirm(t("marketplace.deleteAgentConfirm", { name: agent.title || agent.name }))) return;
			void window.look.deleteAgentDefinition(agent.name).then((result) => {
				if (result?.success) {
					setAgents((prev) => prev.filter((item) => item.name !== agent.name));
					setSelected((current) => (current?.name === agent.name ? null : current));
					toast.success(t("marketplace.deleted"));
				} else {
					toast.error(result?.error ?? t("marketplace.deleteFailed"));
				}
			});
		},
		[setAgents, t],
	);

	const emptyTitle = searchText
		? t("marketplace.noAgentMatch")
		: sourceTab === "builtin"
			? t("marketplace.noBuiltinAgents")
			: t("marketplace.noCustomAgents");
	const emptyDescription = searchText
		? t("marketplace.clearSearch")
		: sourceTab === "builtin"
			? t("marketplace.restartForBuiltins")
			: t("marketplace.createAgentHint");

	return (
		<div className="flex h-full min-h-0 flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0 flex-1">
					<WorkspaceSectionHeading icon={Bot} title={t("marketplace.subagents")} count={filteredAgents.length} />
				</div>
				{sourceTab === "mine" && (
					<Button variant="line-filled" size="sm" className="h-8 gap-1 text-[11px]" onClick={handleAiCreate}>
						<Sparkles className="size-3.5" />
						{t("marketplace.aiCreate")}
					</Button>
				)}
			</div>

			<div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
				<div className="relative min-w-0 flex-1">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={searchText}
						onChange={(event) => setSearchText(event.target.value)}
						placeholder={t("marketplace.searchAgents")}
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
						<Bot className="size-3" />
						{t("marketplace.builtin")}
						<span className="tabular-nums text-[9px] text-muted-foreground/70">
							{agents.filter((a) => a.source === "builtin").length}
						</span>
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={sourceTab === "mine"}
						onClick={() => setSourceTab("mine")}
						className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium transition-colors ${sourceTab === "mine" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
					>
						<User className="size-3" />
						{t("marketplace.mine")}
						<span className="tabular-nums text-[9px] text-muted-foreground/70">
							{agents.filter((a) => a.source === "user" || a.source === "project").length}
						</span>
					</button>
				</div>
			</div>

			{selected && (
				<div className="flex items-start gap-3 rounded-xl border border-primary/25 bg-primary/[0.05] p-3 shadow-[0_8px_22px_var(--material-shadow-soft)]">
					<AgentAvatar icon={selected.icon} />
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-2">
							<h2 className="truncate text-[13px] font-semibold">{selected.title || selected.name}</h2>
							{selected.model && (
								<span className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
									{selected.model}
								</span>
							)}
						</div>
						<p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{selected.description}</p>
						{selected.tags && selected.tags.length > 0 && (
							<div className="mt-2 flex flex-wrap gap-1">
								{selected.tags.map((tag) => (
									<span
										key={tag}
										className="rounded-full border border-primary/20 bg-primary/8 px-1.5 py-0.5 text-[9px] text-primary"
									>
										{tag}
									</span>
								))}
							</div>
						)}
					</div>
					<Button
						variant="line-ghost"
						size="icon-xs"
						aria-label={t("common.close")}
						title={t("common.close")}
						onClick={() => setSelected(null)}
					>
						<X className="size-3.5" />
					</Button>
				</div>
			)}

			<div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
				{loading ? (
					<WorkspaceLoadingState label={t("marketplace.loading")} />
				) : filteredAgents.length === 0 ? (
					<WorkspaceEmptyState
						icon={searchText ? Search : Bot}
						title={emptyTitle}
						description={emptyDescription}
						action={
							searchText ? (
								<Button variant="line" size="sm" onClick={() => setSearchText("")}>
									{t("marketplace.clearSearch")}
								</Button>
							) : sourceTab === "mine" ? (
								<Button variant="line" size="sm" onClick={handleAiCreate}>
									<Sparkles className="size-3.5" />
									{t("marketplace.aiCreate")}
								</Button>
							) : undefined
						}
						className="min-h-[260px] rounded-xl border border-dashed border-hairline bg-muted/[0.08]"
					/>
				) : (
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
						{filteredAgents.map((agent) => (
							<AgentCard
								key={agent.name}
								agent={agent}
								selected={selected?.name === agent.name}
								onSelect={setSelected}
								enabled={isEnabled(agent.name)}
								onToggle={(enabled) => void toggle(agent.name, enabled)}
								onEdit={(target) => setEditorTarget(target.name)}
								onDelete={deleteAgent}
							/>
						))}
					</div>
				)}
			</div>

			<AgentEditor
				target={
					editorTarget === "create"
						? "create"
						: editorTarget
							? (agents.find((a) => a.name === editorTarget) ?? null)
							: null
				}
				onClose={() => setEditorTarget(null)}
				onSaved={handleSaved}
			/>
		</div>
	);
}
