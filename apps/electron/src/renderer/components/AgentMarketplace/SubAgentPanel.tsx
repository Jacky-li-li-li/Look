// ============================================================
// SubAgentPanel — SubAgent 管理页面（从 AgentMarketplacePanel 重构）
//
// 搜索 + 内置/我的 Segment 切换 + Agent 卡片网格。
// 每张卡片带 Switch 开关，支持逐项启用/禁用。
// "我的"模块显示 AI 创建按钮（跳转默认工作区新会话并预填创建 Skill）和编辑/删除操作。
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
import {
	chatInputInsertRequestAtom,
	enabledAgentDefinitionsAtom,
	showAgentSquareAtom,
	showScheduledTasksAtom,
} from "../../store/atoms";
import { appStore } from "../../store/ipcHandler";
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

	const {
		isEnabled,
		toggle,
		setEnabledNames: loadEnabled,
	} = useToggleEnabled({
		getAllNames: useCallback(() => agents.map((a) => a.name), [agents]),
		setEnabled: useCallback(
			async (name: string, enabled: boolean) => window.look.setAgentDefinitionEnabled(name, enabled),
			[],
		),
		// 同步启用集合到全局 atom,供输入框 # 弹窗等跨组件读取
		onChange: useCallback((names: string[] | null) => setEnabledAgentDefs(names), [setEnabledAgentDefs]),
	});

	// 加载 Agent 列表
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

	useEffect(() => {
		loadAgents();
		loadEnabled();
	}, [loadAgents, loadEnabled]);

	// 来源筛选："内置"=仅 Look 预装，"我的"=用户创建 + 项目专属
	const sourceFiltered = useMemo(() => {
		let list = agents;
		if (sourceTab === "builtin") {
			list = list.filter((a) => a.source === "builtin");
		} else {
			list = list.filter((a) => a.source === "user" || a.source === "project");
		}
		return list;
	}, [agents, sourceTab]);

	// 搜索
	const filteredAgents = useMemo(() => {
		let list = sourceFiltered;
		const term = searchText.trim().toLowerCase();
		if (term) {
			list = list.filter(
				(a) =>
					a.name.toLowerCase().includes(term) ||
					(a.title ?? "").toLowerCase().includes(term) ||
					a.description.toLowerCase().includes(term),
			);
		}
		return list;
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
		},
		[setAgents],
	);

	const { handleCreateClick } = useAgentActions();

	// AI 创建：退出广场 → 切到默认工作区 → 新建会话 → 输入框预填 Agent 创建 Skill
	const handleAiCreate = useCallback(async () => {
		appStore.set(showAgentSquareAtom, false);
		appStore.set(showScheduledTasksAtom, false);
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

	return (
		<div className="flex h-full flex-col gap-3">
			{/* 顶栏：搜索 + AI 创建（仅"我的"模块） */}
			<div className="flex items-center gap-2">
				<div className="relative flex-1">
					<Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={searchText}
						onChange={(e) => setSearchText(e.target.value)}
						placeholder={t("marketplace.searchAgents")}
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
				{sourceTab === "mine" && (
					<Button variant="line-filled" size="sm" className="h-7 gap-1 text-[11px]" onClick={handleAiCreate}>
						<Sparkles className="size-3.5" />
						{t("marketplace.aiCreate")}
					</Button>
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
					<Bot className="size-3" />
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
					<User className="size-3" />
					{t("marketplace.mine")}
				</button>
			</div>

			{/* Agent 卡片网格 */}
			<div className="flex-1 overflow-y-auto">
				{loading ? (
					<p className="py-12 text-center text-xs text-muted-foreground">{t("marketplace.loading")}</p>
				) : filteredAgents.length === 0 ? (
					<div className="flex flex-col items-center justify-center py-12 gap-2 text-xs text-muted-foreground">
						{searchText ? (
							<>
								<p>{t("marketplace.noAgentMatch")}</p>
								<button
									type="button"
									className="text-[10px] underline hover:text-foreground"
									onClick={() => setSearchText("")}
								>
									{t("marketplace.clearSearch")}
								</button>
							</>
						) : sourceTab === "builtin" ? (
							<>
								<p>{t("marketplace.noBuiltinAgents")}</p>
								<p className="text-[10px]">{t("marketplace.restartForBuiltins")}</p>
							</>
						) : (
							<>
								<p>{t("marketplace.noCustomAgents")}</p>
								<p className="text-[10px]">{t("marketplace.createAgentHint")}</p>
							</>
						)}
					</div>
				) : (
					<div className="grid grid-cols-2 gap-2">
						{filteredAgents.map((agent) => (
							<AgentCard
								key={agent.name}
								agent={agent}
								selected={selected?.name === agent.name}
								onSelect={setSelected}
								enabled={isEnabled(agent.name)}
								onToggle={(enabled) => toggle(agent.name, enabled)}
								onEdit={(a) => setEditorTarget(a.name)}
								onDelete={(a) => {
									if (window.confirm(t("marketplace.deleteAgentConfirm", { name: a.title || a.name }))) {
										window.look.deleteAgentDefinition(a.name).then((r) => {
											if (r?.success) {
												setAgents((prev) => prev.filter((x) => x.name !== a.name));
												toast.success(t("marketplace.deleted"));
											} else {
												toast.error(r?.error ?? t("marketplace.deleteFailed"));
											}
										});
									}
								}}
							/>
						))}
					</div>
				)}
			</div>

			{/* 编辑对话框 */}
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
