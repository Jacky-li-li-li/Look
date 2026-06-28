// ============================================================
// AgentHashMenu — inline `#agentName` picker for SubAgent selection
//
// Mirror of SkillSlashMenu.tsx for the `#` trigger. Renders a list
// of enabled Agent definitions as a floating panel above the input.
// Keyboard-first (↑↓ Enter Esc) + mouse click.
//
// Pure presentation — does NOT call any IPC. Parent ChatInput owns
// data and state.
// ============================================================

import { Bot } from "lucide-react";
import type React from "react";
import type { AgentDefinitionInfo } from "@shared/types";
import { SOURCE_LABELS } from "./AgentMarketplace/AgentCard";
import { usePickerMenu } from "./usePickerMenu";

// ---- 来源标签 ----

function sourceBadge(source: string): { label: string; glyph: string } {
	switch (source) {
		case "user":
			return { label: SOURCE_LABELS.user, glyph: "👤" };
		case "project":
			return { label: SOURCE_LABELS.project, glyph: "📁" };
		case "builtin":
			return { label: SOURCE_LABELS.builtin, glyph: "🤖" };
		default:
			return { label: source, glyph: "📦" };
	}
}

// ---- Props ----

export interface AgentHashMenuProps {
	/** Enabled agent definitions to pick from. */
	agents: AgentDefinitionInfo[];
	/** Current search term after `#` for contextual empty message. */
	searchTerm?: string;
	/** Active index across the flat pickable list. */
	selectedIndex: number;
	/** Notify parent of index change (mouse hover / keyboard). */
	onSelectedIndexChange: (index: number) => void;
	/** User picked an agent. Parent inserts `#agentName ` into input. */
	onSelectAgent: (agent: AgentDefinitionInfo) => void;
	/** Esc / click-outside. */
	onClose: () => void;
	/** Whether the global SubAgent toggle is ON. */
	subagentEnabled?: boolean;
}

// ---- Single Row ----

function MenuRow({
	active,
	agent,
	badge,
	onClick,
	onMouseEnter,
	rowRef,
}: {
	active: boolean;
	agent: AgentDefinitionInfo;
	badge?: string;
	onClick: () => void;
	onMouseEnter: () => void;
	rowRef?: (el: HTMLButtonElement | null) => void;
}) {
	return (
		<button
			ref={rowRef}
			type="button"
			onClick={onClick}
			onMouseEnter={onMouseEnter}
			className={[
				"flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left transition-all",
				active
					? "border-2 dark:border-accent/70 border-black/50 bg-accent/15 text-foreground shadow-sm"
					: "border-2 border-transparent text-foreground/85 hover:bg-accent/10",
			].join(" ")}
		>
			<span className="text-base leading-none shrink-0 mt-px" aria-hidden>
				{agent.icon ?? "🤖"}
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex items-center gap-1.5">
					<span className="truncate font-mono text-[12px] font-medium">
						{agent.title || agent.name}
					</span>
					{badge ? (
						<span className="shrink-0 rounded-sm border border-hairline bg-background/40 px-1 py-px text-[9px] uppercase tracking-wide text-muted-foreground">
							{badge}
						</span>
					) : null}
				</span>
				<span className="truncate text-[10.5px] text-muted-foreground">
					{agent.description}
				</span>
			</span>
		</button>
	);
}

// ---- Main Component ----

export function AgentHashMenu(props: AgentHashMenuProps) {
	const { agents, selectedIndex, onSelectAgent, onClose, searchTerm, subagentEnabled } = props;
	const { menuRef, containerClassName, onKeyDown, refs } = usePickerMenu({
		total: agents.length,
		selectedIndex,
		onClose,
	});
	const { clampedIndex, setRowRef } = refs;

	return (
		<div ref={menuRef} onKeyDown={onKeyDown} className={containerClassName}>
			{/* Header */}
			<div className="flex items-center gap-1.5 border-b border-hairline px-2.5 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
				<Bot className="size-3" />
				<span>Available agents</span>
				<span className="ml-auto rounded-sm border border-hairline bg-background/40 px-1 py-px text-[9px]">
					{agents.length} · ↑↓ Enter · Esc
				</span>
			</div>

			{/* SubAgent 关闭提示 */}
			{subagentEnabled === false && (
				<div className="border-b border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[10px] text-amber-600 dark:text-amber-400">
					当前会话暂未开启 SubAgent 模式，请点击输入框下方的
					<span className="inline-flex items-center gap-0.5 mx-0.5 px-1 rounded-sm bg-amber-500/20 font-medium">
						<Bot className="size-3" /> 机器人图标
					</span>
					开启
				</div>
			)}

			{/* Agent list */}
			<div className="max-h-72 overflow-y-auto p-1.5">
				{agents.length === 0 ? (
					<div className="flex flex-col items-center gap-1 px-3 py-6 text-center">
						<Bot className="size-5 text-muted-foreground/60" />
						<div className="text-[11.5px] text-muted-foreground">
							{searchTerm
								? `没有匹配 "${searchTerm}" 的 Agent`
								: "没有可用的 Agent"}
						</div>
						<div className="text-[10px] text-muted-foreground/70">
							{searchTerm
								? "尝试其他关键词"
								: "在 Agent 广场中启用 SubAgent 后即可使用"}
						</div>
					</div>
				) : (
					agents.map((agent, i) => {
						const src = agent.source;
						const badge = sourceBadge(src);
						return (
							<MenuRow
								key={`agent-${agent.name}`}
								rowRef={setRowRef(i)}
								active={clampedIndex === i}
								agent={agent}
								badge={badge.label}
								onClick={() => onSelectAgent(agent)}
								onMouseEnter={() => props.onSelectedIndexChange(i)}
							/>
						);
					})
				)}
			</div>

			{/* Footer */}
			<div className="border-t border-hairline bg-background/30 px-2.5 py-1 text-[10px] text-muted-foreground">
				输入 # 选择 SubAgent，多个 Agent 用多个 # 指定
			</div>
		</div>
	);
}
