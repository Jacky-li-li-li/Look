// ============================================================
// SubagentToolGroup — subagent 类工具调用的独立卡片区
//
// 从执行组（CollapsibleExecutionGroup）拆出的 subagent 调用集合：
// 轻量头部（数量 + 折叠开关）默认展开，下面直接用头像卡片展示，
// 不经过 ToolCallCard。点卡片弹窗看 task（SubagentArgsCards）。
// ============================================================

import { cn } from "@look/ui";
import { Bot, ChevronRight } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { useConversationContextSafe } from "./conversation";
import SubagentArgsCards, { parseSubagentItems } from "./SubagentArgsCards";
import type { ToolCallViewModel } from "./ToolCallCard";

interface SubagentToolGroupProps {
	/** 每个 subagent 类工具调用一个 view model（保持源顺序） */
	calls: ToolCallViewModel[];
}

const SubagentToolGroup = React.memo(function SubagentToolGroup({ calls }: SubagentToolGroupProps) {
	const { t } = useTranslation();
	// 仅在处于 Conversation（StickToBottom）内时可用；独立渲染（测试等）时优雅降级
	const ctx = useConversationContextSafe();
	// 默认展开，点击头部手动折叠
	const [expanded, setExpanded] = React.useState(true);

	// 重新展开时脱离“贴底”锁定：防止 stick-to-bottom 的 resize 跟随把视口拽到
	// 展开后内容的底部（与 CollapsibleExecutionGroup 同一问题的 subagent 版本）。
	const handleToggle = React.useCallback(() => {
		if (!expanded) ctx?.stopScroll();
		setExpanded((prev) => !prev);
	}, [expanded, ctx]);

	// 流式早期 args 未完整 / 历史异常参数：跳过，待 args 完整后自然出现
	const renderable = React.useMemo(
		() =>
			calls
				.map((toolCall) => ({ toolCall, items: parseSubagentItems(toolCall) }))
				.filter(
					(entry): entry is { toolCall: ToolCallViewModel; items: NonNullable<typeof entry.items> } =>
						entry.items !== null,
				),
		[calls],
	);

	if (renderable.length === 0) return null;

	// 计数按子代理（卡片项）总数，而非工具调用次数：
	// 一次 subagent_parallel/chain 调用包含多个子代理
	const totalItems = renderable.reduce((n, entry) => n + entry.items.length, 0);

	return (
		<div className="flex flex-col" data-subagent-group="" data-open={expanded}>
			<button
				type="button"
				aria-expanded={expanded}
				onClick={handleToggle}
				className={cn(
					"flex w-full cursor-pointer items-center gap-1.5 py-0.5 pr-2 text-left outline-none",
					"text-[10px] hover:text-foreground transition-colors",
					expanded ? "text-foreground" : "text-muted-foreground",
				)}
			>
				<ChevronRight
					className={cn("size-3 shrink-0 transition-transform duration-150", expanded && "rotate-90")}
				/>
				<Bot className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] tracking-wide text-muted-foreground">
					{t("tool.subagentGroup", { n: totalItems })}
				</span>
			</button>
			<div
				data-subagent-group-body=""
				data-open={expanded}
				aria-hidden={!expanded}
				className="grid"
				style={{
					gridTemplateRows: expanded ? "1fr" : "0fr",
					opacity: expanded ? 1 : 0,
					transition: "grid-template-rows 380ms cubic-bezier(0.0, 0.0, 0.2, 1), opacity 320ms ease",
					pointerEvents: expanded ? undefined : "none",
				}}
			>
				<div className="overflow-hidden">
					<div className="flex flex-col">
						{renderable.map(({ toolCall, items }) => (
							<SubagentArgsCards
								key={toolCall.callId || `${toolCall.toolName}-${items.length}`}
								toolCall={toolCall}
								items={items}
								status={toolCall.status}
							/>
						))}
					</div>
				</div>
			</div>
		</div>
	);
});

export default SubagentToolGroup;
