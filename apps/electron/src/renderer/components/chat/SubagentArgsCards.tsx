// ============================================================
// SubagentArgsCards — subagent 类工具调用的参数卡片视图
//
// 将 subagent / subagent_parallel / subagent_chain 的参数渲染为
// 卡片列表（头像 + title + agent 名），替代原始 JSON 展示；
// 点击卡片弹窗展示完整 task。结果不在此展示——子会话本身在
// 侧边栏中可继续交互，结果以会话形式呈现。
// 头像按会话随机分配且不重复（见 lib/subagentAvatars.ts）。
// ============================================================

import { cn } from "@look/ui";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@look/ui/components/ui/dialog";
import { useAtomValue } from "jotai";
import { subagentCardStatusAtom, type SubagentCardStatus } from "../../store/subagentAtoms";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { assignPeepId } from "../../lib/subagentAvatars";
import { activeAgentIdAtom } from "../../store/agentAtoms";
import AgentAvatar from "../AgentMarketplace/AgentAvatar";
import { makeOpenPeepIcon } from "../AgentMarketplace/openPeeps";
import LookMarkdown from "../markdown/LookMarkdown";
import type { ToolCallViewModel } from "./ToolCallCard";

export interface SubagentItem {
	agent: string;
	title: string;
	task: string;
}

const SUBAGENT_TOOL_NAMES = new Set(["subagent", "subagent_parallel", "subagent_chain"]);

export function isSubagentTool(toolName: string): boolean {
	return SUBAGENT_TOOL_NAMES.has(toolName);
}

function asItem(value: unknown): SubagentItem | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	if (typeof v.agent !== "string" || typeof v.task !== "string") return null;
	return {
		agent: v.agent,
		title: typeof v.title === "string" ? v.title : "",
		task: v.task,
	};
}

/**
 * 解析 subagent 类工具的参数为卡片项列表。
 * 结构不符（历史会话 / 异常参数）返回 null，调用方回退到原始 JSON 展示。
 */
export function parseSubagentItems(toolCall: ToolCallViewModel): SubagentItem[] | null {
	const args = toolCall.args ?? {};
	if (toolCall.toolName === "subagent") {
		const item = asItem(args);
		return item ? [item] : null;
	}
	const list =
		toolCall.toolName === "subagent_parallel"
			? args.tasks
			: toolCall.toolName === "subagent_chain"
				? args.chain
				: undefined;
	if (!Array.isArray(list) || list.length === 0) return null;
	const items = list.map(asItem);
	return items.every((item): item is SubagentItem => item !== null) ? items : null;
}

interface SubagentArgsCardsProps {
	toolCall: ToolCallViewModel;
	items: SubagentItem[];
	/** Tool-level status — used as fallback when per-card atom data is unavailable (history view). */
	status?: ToolCallViewModel["status"];
}



const ITEM_STATUS_BADGE: Record<SubagentCardStatus, { color: string; label: string }> = {
	running: { color: "text-amber-500 dark:text-amber-300", label: "running" },
	completed: { color: "text-emerald-500 dark:text-emerald-400", label: "completed" },
	failed: { color: "text-red-500 dark:text-red-400", label: "failed" },
	aborted: { color: "text-red-500 dark:text-red-400", label: "aborted" },
};

export default function SubagentArgsCards({ toolCall, items, status }: SubagentArgsCardsProps) {
	const { t } = useTranslation();
	const sessionId = useAtomValue(activeAgentIdAtom);
	const cardStatuses = useAtomValue(subagentCardStatusAtom);
	const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

	/** Map tool-level status to per-card status as fallback for history view. */
	const fallbackStatus: SubagentCardStatus =
		status === "success" ? "completed"
		: status === "error" ? "failed"
		: "running";
	const callKeyFor = (index: number): string =>
		toolCall.toolName === "subagent" ? toolCall.callId : `${toolCall.callId}:${index}`;

	const peepIdAt = (index: number): string => {
		// 无活动会话（理论上不会发生）时归入共享 anonymous 桶，仍保证随机
		return assignPeepId(sessionId ?? "anonymous", callKeyFor(index));
	};

	const selected = selectedIndex !== null ? items[selectedIndex] : null;

	return (
		<div className="flex flex-col gap-1.5 py-0.5">
			{items.map((item, index) => {
				const key = callKeyFor(index);
				return (
					<button
						key={key}
						type="button"
						onClick={() => setSelectedIndex(index)}
						className={cn(
							"flex w-full items-center gap-2.5 rounded-lg border border-hairline bg-card/40 px-2.5 py-2 text-left",
							"transition-colors hover:bg-muted/50",
						)}
					>
						<AgentAvatar icon={makeOpenPeepIcon(peepIdAt(index))} className="h-8 w-8 shrink-0" />
						<span className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span className="truncate text-[13px] font-medium text-foreground">
								{item.title || item.agent}
							</span>
							<span className="truncate font-mono text-[11px] text-muted-foreground">{item.agent}</span>
						</span>
						{(() => {
							const itemStatus: SubagentCardStatus = cardStatuses[toolCall.callId]?.[item.title] ?? fallbackStatus;
							const badge = ITEM_STATUS_BADGE[itemStatus];
							return (
								<span
									className={cn(
										"shrink-0 font-mono text-[9px] uppercase tracking-wider",
										badge.color,
									)}
								>
									{badge.label}
								</span>
							);
						})()}
						<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
					</button>
				);
			})}

			{/* 任务简报弹窗：弹窗 = 主会话签发给子代理的派工单。
			    头部路由带（眉毛「简报 → 收件人」+ 大头像 + title）把“委派”
			    编码进结构；正文左侧 accent 引用线呈现被签发的简报原文。 */}
			<Dialog open={selected !== null} onOpenChange={(open) => !open && setSelectedIndex(null)}>
				<DialogContent className="max-w-2xl gap-0 overflow-hidden p-0">
					{selected && selectedIndex !== null && (
						<>
							<div className="flex items-center gap-3.5 border-b border-hairline px-5 py-4">
								<AgentAvatar
									icon={makeOpenPeepIcon(peepIdAt(selectedIndex))}
									className="h-11 w-11 shrink-0 ring-1 ring-hairline"
								/>
								<div className="flex min-w-0 flex-1 flex-col gap-1">
									<span className="font-mono text-[9px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
										{t("tool.subagentBrief")}
										<span className="mx-1 text-accent">→</span>
										{selected.agent}
									</span>
									<DialogHeader className="p-0">
										<DialogTitle className="truncate text-[15px] font-semibold leading-snug text-foreground">
											{selected.title || selected.agent}
										</DialogTitle>
									</DialogHeader>
								</div>
							</div>
							<div className="max-h-[65vh] overflow-auto px-5 py-4 text-[12px]">
								<div className="border-l-2 border-accent/40 pl-4">
									<LookMarkdown content={selected.task} />
								</div>
							</div>
						</>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}
