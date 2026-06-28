// ============================================================
// AgentMarketplacePanel — Agent 广场主面板（Stage 3）
//
// 搜索 + 分类筛选 + Agent 卡片网格 + 新建/编辑/删除操作。
// 作为 SettingsDialog 的 "Agents" 标签页内容嵌入。
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import type { AgentDefinitionInfo } from "@shared/types";
import { useAtom } from "jotai";
import { Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	agentDefinitionsAtom,
	agentDefinitionsLoadingAtom,
	agentEditorTargetAtom,
	agentFilterTagAtom,
	agentSearchTextAtom,
} from "../../store/agentDefinitionsAtoms";
import AgentCard from "./AgentCard";
import AgentEditor from "./AgentEditor";

const ALL_TAG = "__all__";

/** 从已有 Agent 的 tags 中提取全部独特标签，并以"全部"为首项 */
function useFilterTags(agents: AgentDefinitionInfo[]): string[] {
	return useMemo(() => {
		const seen = new Set<string>();
		for (const agent of agents) {
			for (const tag of agent.tags ?? []) {
				seen.add(tag);
			}
		}
		return [ALL_TAG, ...Array.from(seen).sort()];
	}, [agents]);
}

export default function AgentMarketplacePanel() {
	const [agents, setAgents] = useAtom(agentDefinitionsAtom);
	const [editorTarget, setEditorTarget] = useAtom(agentEditorTargetAtom);
	const [filterTag, setFilterTag] = useAtom(agentFilterTagAtom);
	const [searchText, setSearchText] = useAtom(agentSearchTextAtom);
	const [loading, setLoading] = useAtom(agentDefinitionsLoadingAtom);
	const [selected, setSelected] = useState<AgentDefinitionInfo | null>(null);

	const filterTags = useFilterTags(agents);

	// 加载 Agent 列表
	const loadAgents = useCallback(async () => {
		setLoading(true);
		try {
			const result = await window.look.listAgentDefinitions();
			if (result?.success && Array.isArray(result.agents)) {
				setAgents(result.agents);
			} else {
				toast.error(result?.error ?? "无法加载 Agent 列表");
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "加载 Agent 列表失败");
		} finally {
			setLoading(false);
		}
	}, [setAgents, setLoading]);

	useEffect(() => {
		loadAgents();
	}, [loadAgents]);

	// 筛选 + 搜索
	const filteredAgents = useMemo(() => {
		let list = agents;
		if (filterTag && filterTag !== ALL_TAG) {
			list = list.filter((a) => (a.tags ?? []).includes(filterTag));
		}
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
	}, [agents, filterTag, searchText]);

	const handleSaved = useCallback(
		(saved: AgentDefinitionInfo) => {
			// 更新列表：替换已有或追加
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

	return (
		<div className="flex h-full flex-col gap-3">
			{/* 顶栏：搜索 + 新建 */}
			<div className="flex items-center gap-2">
				<div className="relative flex-1">
					<Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={searchText}
						onChange={(e) => setSearchText(e.target.value)}
						placeholder="搜索 Agent 名称、描述..."
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
				<Button
					variant="line-filled"
					size="sm"
					className="h-7 gap-1 text-[11px]"
					onClick={() => setEditorTarget("create")}
				>
					<Plus className="size-3.5" />
					新建
				</Button>
			</div>

			{/* 分类筛选 */}
			{filterTags.length > 1 && (
				<div className="flex flex-wrap items-center gap-1.5">
					{filterTags.map((tag) => {
						const active = (filterTag ?? ALL_TAG) === tag;
						return (
							<Badge
								key={tag}
								variant={active ? "default" : "outline"}
								className="h-5 cursor-pointer px-2 text-[10px] transition-colors hover:bg-accent"
								onClick={() => setFilterTag(tag === ALL_TAG ? null : tag)}
							>
								{tag === ALL_TAG ? "全部" : tag}
							</Badge>
						);
					})}
				</div>
			)}

			{/* Agent 卡片网格 */}
			<div className="flex-1 overflow-y-auto">
				{loading ? (
					<p className="py-12 text-center text-xs text-muted-foreground">加载中...</p>
				) : filteredAgents.length === 0 ? (
					<div className="flex flex-col items-center justify-center py-12 gap-2 text-xs text-muted-foreground">
						{searchText || (filterTag && filterTag !== ALL_TAG) ? (
							<>没有匹配的 Agent</>
						) : (
							<>
								<p>暂无 Agent 定义</p>
								<p className="text-[10px]">点击"新建"创建第一个 Agent，或从广场安装</p>
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
								onEdit={(a) => setEditorTarget(a.name)}
								onDelete={(a) => {
									if (window.confirm(`确定删除 Agent "${a.title || a.name}"？`)) {
										window.look.deleteAgentDefinition(a.name).then((r) => {
											if (r?.success) {
												setAgents((prev) => prev.filter((x) => x.name !== a.name));
												toast.success("已删除");
											} else {
												toast.error(r?.error ?? "删除失败");
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
