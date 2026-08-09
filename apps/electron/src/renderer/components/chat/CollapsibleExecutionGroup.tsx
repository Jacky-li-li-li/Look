// ============================================================
// CollapsibleExecutionGroup — collapses a run of consecutive
// thinking + tool blocks into a single "executed N tools" badge.
// Auto-open is disabled; user clicks to expand/collapse manually.
// The badge title shows real-time tool/thinking counts.
// ============================================================

import type { ThinkingContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { cn } from "@look/ui";
import type { LookUiToolExecState } from "@shared/types";
import { Brain, ChevronRight, Wrench } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { hashKey } from "../../lib/stableKey";
import { useConversationContextSafe } from "./conversation";
import SkillAwareContent from "./SkillAwareContent";
import ThinkingPanel from "./ThinkingPanel";
import ToolCallCard from "./ToolCallCard";

export interface CollapsibleExecutionGroupProps {
	blocks: Array<ThinkingContent | ToolCall>;
	/** Short inline text notes that sit between tool/thinking blocks in the
	 * source order — preserved as visible labels in both collapsed and
	 * expanded states so the reader can still follow the narrative. */
	inlineTexts?: string[];
	toolExecutions: Record<string, LookUiToolExecState>;
	toolResultMap?: Record<string, ToolResultMessage>;
	isStreaming: boolean;
	/** 组内 ThinkingPanel 的 autoCollapse（流式中调用方传 false；完成后恢复设置值）。 */
	autoCollapse?: boolean;
}

type GroupKind = "thinking" | "tools" | "mixed";

function classify(blocks: Array<ThinkingContent | ToolCall>): {
	kind: GroupKind;
	thinkingCount: number;
	toolCount: number;
} {
	let thinkingCount = 0;
	let toolCount = 0;
	for (const b of blocks) {
		if (b.type === "thinking") thinkingCount++;
		else if (b.type === "toolCall") toolCount++;
	}
	let kind: GroupKind;
	if (thinkingCount > 0 && toolCount > 0) kind = "mixed";
	else if (thinkingCount > 0) kind = "thinking";
	else kind = "tools";
	return { kind, thinkingCount, toolCount };
}

function statusFor(
	block: ThinkingContent | ToolCall,
	toolExecutions: Record<string, LookUiToolExecState>,
	toolResultMap: Record<string, ToolResultMessage> | undefined,
): "pending" | "running" | "success" | "error" {
	if (block.type === "thinking") return "success";
	const execution = toolExecutions[block.id];
	if (execution) {
		return execution.phase === "running" ? "running" : execution.isError ? "error" : "success";
	}
	const persisted = toolResultMap?.[block.id];
	if (persisted) return persisted.isError ? "error" : "success";
	return "pending";
}

function resultFor(
	block: ThinkingContent | ToolCall,
	toolExecutions: Record<string, LookUiToolExecState>,
	toolResultMap: Record<string, ToolResultMessage> | undefined,
): unknown {
	if (block.type === "thinking") return undefined;
	const execution = toolExecutions[block.id];
	if (execution) {
		return execution.result ?? execution.partialResult;
	}
	const persisted = toolResultMap?.[block.id];
	if (!persisted) return undefined;
	return persisted.content;
}

const CollapsibleExecutionGroup = React.memo(function CollapsibleExecutionGroup({
	blocks,
	inlineTexts = [],
	toolExecutions,
	toolResultMap,
	isStreaming,
	autoCollapse = true,
}: CollapsibleExecutionGroupProps) {
	const { t } = useTranslation();
	// 仅在处于 Conversation（StickToBottom）内时可用；独立渲染（测试等）时优雅降级
	const ctx = useConversationContextSafe();
	const { kind, thinkingCount, toolCount } = React.useMemo(() => classify(blocks), [blocks]);
	const summary = React.useMemo(() => {
		if (kind === "mixed") return t("tool.mixedExecuted", { thinking: thinkingCount, tools: toolCount });
		if (kind === "thinking") return t("tool.thinkingExecuted", { count: thinkingCount });
		return t("tool.executed", { count: toolCount });
	}, [kind, thinkingCount, toolCount, t]);
	// Badge numbers roll on change (keyed re-mount replays roll-in); splitting
	// the translated string keeps every locale's wording and word order intact.
	const label = React.useMemo(() => renderRollingLabel(summary), [summary]);

	const [expanded, setExpanded] = React.useState(false);
	const [hasRenderedBody, setHasRenderedBody] = React.useState(false);

	const isOpen = expanded;

	// 点击展开时主动脱离“贴底”锁定（stopScroll），再切换展开状态：
	// 防止 stick-to-bottom 的 resize 跟随把视口弹簧拽到展开后内容的最底部——
	// 工具调用很多时展开高度骤增，视口落点处于 staggered reveal 延迟期（
	// animationDelay: i*20ms，末尾卡片最长延迟 600ms+，opacity 仍为 0），
	// 用户会看到空白并被迫等待动画滚到底部。
	// 折叠时不需要 stopScroll（负 resize 在近底部时会自动恢复贴底）。
	const handleBadgeClick = React.useCallback(() => {
		if (!expanded) {
			ctx?.stopScroll();
			setHasRenderedBody(true);
		}
		setExpanded((prev) => !prev);
	}, [expanded, ctx]);

	const handleBadgeKeyDown = React.useCallback(
		(e: React.KeyboardEvent<HTMLButtonElement>) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				// 统一走 handleBadgeClick：键盘展开同样需要 stopScroll，
				// 否则键盘用户展开大工具组时仍会被拽到 reveal 延迟期的最底部。
				handleBadgeClick();
			}
		},
		[handleBadgeClick],
	);

	// Optional inlineTexts: when provided (e.g. caller wants a note shown
	// alongside the cards), interleave them between blocks. When empty
	// (the default), just render the blocks directly.
	const interleaved = React.useMemo(() => {
		const result: Array<
			{ kind: "text"; text: string } | { kind: "block"; block: ThinkingContent | ToolCall; index: number }
		> = [];
		const textCount = Math.min(inlineTexts.length, blocks.length);
		for (let i = 0; i < blocks.length; i++) {
			if (i < textCount && inlineTexts[i]) {
				result.push({ kind: "text", text: inlineTexts[i] });
			}
			result.push({ kind: "block", block: blocks[i], index: i });
		}
		for (let i = textCount; i < inlineTexts.length; i++) {
			if (inlineTexts[i]) result.push({ kind: "text", text: inlineTexts[i] });
		}
		return result;
	}, [blocks, inlineTexts]);

	if (blocks.length === 0) return null;

	return (
		<div className="flex flex-col" data-execution-group="" data-open={isOpen}>
			<BadgeTrigger
				kind={kind}
				isOpen={isOpen}
				label={label}
				onClick={handleBadgeClick}
				onKeyDown={handleBadgeKeyDown}
			/>
			<div
				data-execution-group-body=""
				data-open={isOpen}
				aria-hidden={!isOpen}
				className="grid"
				style={{
					gridTemplateRows: isOpen ? "1fr" : "0fr",
					opacity: isOpen ? 1 : 0,
					transition: "grid-template-rows 180ms cubic-bezier(0.0, 0.0, 0.2, 1), opacity 150ms ease",
					pointerEvents: isOpen ? undefined : "none",
				}}
			>
				<div className="overflow-hidden">
					{hasRenderedBody ? (
						<div className="flex flex-col">
							{interleaved.map((node, i) => {
								// 封顶 stagger 延迟：工具很多时末尾卡片不再需要等 i*20ms 才出现，
								// 空白窗口（reveal 前 opacity 仍为 0）有上限，避免任何路径被拽到
								// 底部时长时间看到空白。
								const revealDelay = Math.min(i * 20, 200);
								return node.kind === "text" ? (
									<div
										key={`note-${i}-${hashKey(node.text)}`}
										data-tool-group-item=""
										className="message-prose text-[10px] text-muted-foreground"
										style={{ animationDelay: `${revealDelay}ms` }}
									>
										<SkillAwareContent content={node.text} isStreaming={isStreaming} />
									</div>
								) : (
									<div
										key={`item-${node.index}`}
										data-tool-group-item=""
										style={{ animationDelay: `${revealDelay}ms` }}
									>
										{renderBlock(
											node.block,
											node.index,
											toolExecutions,
											toolResultMap,
											isStreaming,
											autoCollapse,
										)}
									</div>
								);
							})}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
});

function renderBlock(
	block: ThinkingContent | ToolCall,
	index: number,
	toolExecutions: Record<string, LookUiToolExecState>,
	toolResultMap: Record<string, ToolResultMessage> | undefined,
	isStreaming: boolean,
	autoCollapse: boolean,
): React.ReactNode {
	if (block.type === "thinking") {
		const sig = (block as ThinkingContent).thinkingSignature;
		return (
			<ThinkingPanel
				key={sig != null ? `${sig}-${index}` : `thinking-${index}`}
				thinking={block.thinking}
				isStreaming={isStreaming}
				autoCollapse={autoCollapse}
			/>
		);
	}
	const status = statusFor(block, toolExecutions, toolResultMap);
	const result = resultFor(block, toolExecutions, toolResultMap);
	const isError = status === "error";
	return (
		<ToolCallCard
			key={block.id || `tool-${block.name}-${hashKey(JSON.stringify(block.arguments ?? {}))}`}
			toolCall={{
				callId: block.id,
				toolName: block.name,
				args: block.arguments,
				status,
				result,
				isError,
			}}
		/>
	);
}

function RollingNumber({ value }: { value: number }) {
	return (
		<span className="inline-flex overflow-hidden" style={{ height: "1em", lineHeight: 1 }}>
			<span
				key={value}
				className="inline-block animate-[roll-in_220ms_cubic-bezier(0,0,0.2,1)_both]"
				style={{ animationFillMode: "both" }}
			>
				{value}
			</span>
		</span>
	);
}

// Splits the translated badge text on digit runs and renders each number as
// a RollingNumber, so live count changes replay the roll-in animation without
// touching any locale string. Locales that spell numbers as words just get
// static text.
function renderRollingLabel(summary: string): React.ReactNode {
	return summary
		.split(/(\d+)/)
		.map((part, i) =>
			/^\d+$/.test(part) ? (
				<RollingNumber key={`n-${i}`} value={Number(part)} />
			) : (
				<React.Fragment key={`t-${i}`}>{part}</React.Fragment>
			),
		);
}

interface BadgeTriggerProps {
	kind: GroupKind;
	isOpen: boolean;
	label: React.ReactNode;
	onClick: () => void;
	onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
}

function BadgeTrigger({ kind, isOpen, label, onClick, onKeyDown }: BadgeTriggerProps) {
	const Icon = kind === "thinking" ? Brain : Wrench;
	const chevron = (
		<ChevronRight className={cn("size-3 shrink-0 transition-transform duration-150", isOpen && "rotate-90")} />
	);

	return (
		<button
			type="button"
			onClick={onClick}
			onKeyDown={onKeyDown}
			aria-expanded={isOpen}
			className={cn(
				"flex w-full cursor-pointer items-center gap-1.5 py-0.5 pr-2 text-left outline-none",
				"text-[10px] hover:text-foreground transition-colors",
				isOpen ? "text-foreground" : "text-muted-foreground",
			)}
		>
			{chevron}
			<Icon className="size-3.5 shrink-0 text-muted-foreground" />
			<span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] tracking-wide text-muted-foreground">
				{label}
			</span>
		</button>
	);
}

export default CollapsibleExecutionGroup;
