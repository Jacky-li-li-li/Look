// ============================================================
// ToolPickerPanel — Tool 按钮的分类工具面板
//
// 从输入框底部工具栏的 Tool 按钮打开，分 技能 / Agent / MCP 工具
// 三类（可切换），顶部带搜索框。选中后在光标处插入对应引用 token：
//   - 技能  → /skill:name
//   - Agent → /agent:name
//   - MCP   → #server__toolName
//
// 纯展示组件：数据由父组件（ChatInput → useChatInputMenus）提供，
// 选中通过 onInsert 回调交给父组件插入输入框。
// ============================================================

import type { AgentDefinitionInfo } from "@shared/types";
import { Bot, Search, Sparkles, Wrench } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import AgentAvatar from "../AgentMarketplace/AgentAvatar";
import { SOURCE_LABELS } from "../AgentMarketplace/agentLabels";
import type { SkillEntry } from "./SkillSlashMenu";

export interface McpPickerEntry {
	server: string;
	toolName: string;
	description: string;
}

export type ToolPickerTab = "skills" | "agents" | "mcp";

interface ToolPickerPanelProps {
	/** 已启用且可被模型调用的技能列表。 */
	skills: SkillEntry[];
	/** 已启用的 Agent 定义列表。 */
	agents: AgentDefinitionInfo[];
	/** 已连接的 MCP 工具列表。 */
	mcpTools: McpPickerEntry[];
	/** 选中工具后回调，token 形如 /skill:x、/agent:x、#server__tool。 */
	onInsert: (token: string) => void;
}

type FlatItem =
	| { kind: "skill"; skill: SkillEntry }
	| { kind: "agent"; agent: AgentDefinitionInfo }
	| { kind: "mcp"; entry: McpPickerEntry };

// ---- 来源标签（Agent / 技能） ----

function agentBadge(source: string): string {
	switch (source) {
		case "user":
			return SOURCE_LABELS.user;
		case "project":
			return SOURCE_LABELS.project;
		case "builtin":
			return SOURCE_LABELS.builtin;
		default:
			return source;
	}
}

function skillBadge(skill: SkillEntry): string {
	switch (skill.sourceInfo?.source ?? skill.source) {
		case "user":
			return "global";
		case "project":
			return "project";
		case "path":
			return "imported";
		case "package":
			return "package";
		default:
			return "skill";
	}
}

// ---- 单个行 ----

function Row({
	active,
	item,
	onClick,
	onMouseEnter,
}: {
	active: boolean;
	item: FlatItem;
	onClick: () => void;
	onMouseEnter: () => void;
}) {
	const baseClass = [
		"flex w-full items-start gap-2 rounded-md border-2 px-2.5 py-1.5 text-left transition-all",
		active
			? "dark:border-accent/70 border-black/50 bg-accent/15 text-foreground shadow-sm"
			: "border-transparent text-foreground/85 hover:bg-accent/10",
	].join(" ");

	if (item.kind === "skill") {
		return (
			<button
				data-active={active ? "true" : undefined}
				type="button"
				onClick={onClick}
				onMouseEnter={onMouseEnter}
				className={baseClass}
			>
				<Sparkles className="size-3.5 shrink-0 mt-0.5 text-muted-foreground/70" />
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="flex items-center gap-1.5">
						<span className="truncate font-mono text-[12px] font-medium">{item.skill.name}</span>
						<span className="shrink-0 rounded-sm border border-hairline bg-background/40 px-1 py-px text-[9px] uppercase tracking-wide text-muted-foreground">
							{skillBadge(item.skill)}
						</span>
					</span>
					<span className="truncate text-[10.5px] text-muted-foreground">{item.skill.description}</span>
				</span>
			</button>
		);
	}

	if (item.kind === "agent") {
		return (
			<button
				data-active={active ? "true" : undefined}
				type="button"
				onClick={onClick}
				onMouseEnter={onMouseEnter}
				className={baseClass}
			>
				<AgentAvatar icon={item.agent.icon} className="shrink-0 mt-px" />
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="flex items-center gap-1.5">
						<span className="truncate font-mono text-[12px] font-medium">
							{item.agent.title || item.agent.name}
						</span>
						<span className="shrink-0 rounded-sm border border-hairline bg-background/40 px-1 py-px text-[9px] uppercase tracking-wide text-muted-foreground">
							{agentBadge(item.agent.source)}
						</span>
					</span>
					<span className="truncate text-[10.5px] text-muted-foreground">{item.agent.description}</span>
				</span>
			</button>
		);
	}

	return (
		<button
			data-active={active ? "true" : undefined}
			type="button"
			onClick={onClick}
			onMouseEnter={onMouseEnter}
			className={baseClass}
		>
			<Wrench
				className={
					active
						? "size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
						: "size-3.5 shrink-0 text-muted-foreground/70"
				}
			/>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="font-mono text-[12px]">
					#{item.entry.server}__{item.entry.toolName}
				</span>
				{item.entry.description && (
					<span className="truncate text-[10px] leading-tight text-muted-foreground/60">
						{item.entry.description}
					</span>
				)}
			</span>
			<span className="shrink-0 rounded-sm border border-hairline bg-background/40 px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">
				{item.entry.server}
			</span>
		</button>
	);
}

// ---- Main Component ----

export const ToolPickerPanel = memo(function ToolPickerPanel({
	skills,
	agents,
	mcpTools,
	onInsert,
}: ToolPickerPanelProps) {
	const [tab, setTab] = useState<ToolPickerTab>("skills");
	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(0);
	const listRef = useRef<HTMLUListElement>(null);

	const items = useMemo<FlatItem[]>(() => {
		const q = query.trim().toLowerCase();
		const match = (s: string) => !q || s.toLowerCase().includes(q);
		if (tab === "skills") {
			return skills
				.filter((s) => match(s.name) || match(s.description))
				.map((skill) => ({ kind: "skill" as const, skill }));
		}
		if (tab === "agents") {
			return agents
				.filter((a) => match(a.name) || match(a.title ?? "") || match(a.description))
				.map((agent) => ({ kind: "agent" as const, agent }));
		}
		return mcpTools
			.filter((t) => match(t.toolName) || match(`${t.server}__${t.toolName}`) || match(t.description))
			.map((entry) => ({ kind: "mcp" as const, entry }));
	}, [tab, query, skills, agents, mcpTools]);

	// 切换分类 / 清空搜索时回到第一行
	useEffect(() => {
		void tab;
		void query;
		setIndex(0);
	}, [tab, query]);

	// 选中行自动滚动到视图
	useEffect(() => {
		void index;
		void items.length;
		listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
	}, [index, items.length]);

	const insert = useCallback(
		(item: FlatItem) => {
			if (item.kind === "skill") onInsert(`/skill:${item.skill.name}`);
			else if (item.kind === "agent") onInsert(`/agent:${item.agent.name}`);
			else onInsert(`#${item.entry.server}__${item.entry.toolName}`);
		},
		[onInsert],
	);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (items.length === 0) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setIndex((i) => Math.min(i + 1, items.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setIndex((i) => Math.max(i - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			const item = items[Math.max(0, Math.min(index, items.length - 1))];
			if (item) insert(item);
		}
	};

	const counts = { skills: skills.length, agents: agents.length, mcp: mcpTools.length };

	return (
		<div
			onKeyDown={handleKeyDown}
			className="flex w-72 flex-col overflow-hidden rounded-lg border border-hairline bg-card/95 shadow-lg backdrop-blur-md"
		>
			{/* 分类 tab — 竖线分隔区域，选中态墨点指示 */}
			<div className="flex items-stretch border-b border-hairline">
				{(
					[
						{ key: "skills", label: "Skills", icon: Sparkles },
						{ key: "agents", label: "Agent", icon: Bot },
						{ key: "mcp", label: "MCP", icon: Wrench },
					] as const
				).map((t) => {
					const Icon = t.icon;
					const activeTab = tab === t.key;
					return (
						<button
							key={t.key}
							type="button"
							onClick={() => setTab(t.key)}
							className={[
								"group relative flex flex-1 items-center justify-center gap-1.5 border-l border-hairline/70 px-2 py-2 text-[11px] transition-colors first:border-l-0",
								activeTab
									? "bg-accent/[0.06] text-foreground"
									: "text-muted-foreground hover:bg-muted/30 hover:text-foreground/80",
							].join(" ")}
						>
							<Icon
								className={[
									"size-3.5 shrink-0 transition-colors",
									activeTab ? "text-foreground" : "text-muted-foreground/70 group-hover:text-foreground/80",
								].join(" ")}
							/>
							<span className="font-medium tracking-wide">{t.label}</span>
							<span
								className={[
									"rounded-sm px-1 text-[9px] tabular-nums transition-colors",
									activeTab ? "bg-accent/15 text-foreground" : "bg-background/40 text-muted-foreground",
								].join(" ")}
							>
								{counts[t.key]}
							</span>
							{/* 选中指示条：墨色下划线 */}
							<span
								className={[
									"absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-foreground transition-all duration-200",
									activeTab ? "scale-x-100 opacity-100" : "scale-x-0 opacity-0",
								].join(" ")}
							/>
						</button>
					);
				})}
			</div>

			{/* 搜索框 */}
			<div className="flex items-center gap-1.5 border-b border-hairline px-2 py-1.5">
				<Search className="size-3 shrink-0 text-muted-foreground" />
				<input
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="搜索…"
					autoFocus
					className="min-w-0 flex-1 bg-transparent text-[12px] placeholder:text-muted-foreground/50 focus:outline-none"
				/>
			</div>

			{/* 列表 */}
			<ul ref={listRef} className="max-h-72 list-none overflow-y-auto p-1.5">
				{items.length === 0 ? (
					<li className="flex flex-col items-center gap-1 px-3 py-6 text-center">
						<Search className="size-5 text-muted-foreground/60" />
						<div className="text-[11.5px] text-muted-foreground">没有匹配「{query}」的工具</div>
					</li>
				) : (
					items.map((item, i) => (
						<li
							key={
								item.kind === "skill"
									? `skill-${item.skill.name}`
									: item.kind === "agent"
										? `agent-${item.agent.name}`
										: `mcp-${item.entry.server}__${item.entry.toolName}`
							}
						>
							<Row
								active={i === Math.max(0, Math.min(index, items.length - 1))}
								item={item}
								onClick={() => insert(item)}
								onMouseEnter={() => setIndex(i)}
							/>
						</li>
					))
				)}
			</ul>

			{/* Footer */}
			<div className="border-t border-hairline bg-background/30 px-2.5 py-1 text-[10px] text-muted-foreground">
				点击插入引用 · ↑↓ 选择 · Enter 确认
			</div>
		</div>
	);
});
