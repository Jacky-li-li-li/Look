// ============================================================
// MessageBlockList — 统一消息块渲染器
//
// 合并快照路径（ContentBlocks）与流式路径（StreamingBlocksBubble）：
// 两者渲染目标完全相同（ThinkingPanel / ToolCallCard /
// CollapsibleExecutionGroup / 文本 / 图片），仅数据形状不同。
// UnifiedBlock（见 blockTypes.ts）归一双源后，这里只保留一份分段
// 与渲染逻辑。
//
// 性能约束：流式路径依赖 per-block React.memo + 稳定引用。
// - 转换器（toUnifiedFromStream）用 WeakMap 缓存，源 block 引用不变时
//   返回同一 UnifiedBlock 对象 → UnifiedBlockView memo 生效；
// - ToolCallCard 的 memo 依赖 args 引用稳定，故 toolCall 视图模型
//   在 MessageBlockList 内 useMemo 预计算（与旧 ContentBlocks 一致）。
// ============================================================

import type { ThinkingContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { LookUiToolExecState } from "@shared/types";
import { useAtomValue } from "jotai";
import { memo } from "react";
import { segmentExecutionBlocks } from "../../../lib/executionSegments";
import { showToolExecutionAtom } from "../../../store/settingsAtoms";
import CollapsibleExecutionGroup from "../CollapsibleExecutionGroup";
import SkillAwareContent from "../SkillAwareContent";
import { isSubagentTool } from "../SubagentArgsCards";
import SubagentToolGroup from "../SubagentToolGroup";
import ThinkingPanel from "../ThinkingPanel";
import ToolCallCard from "../ToolCallCard";
import type { UnifiedBlock } from "./blockTypes";
import { ImageBlock } from "./ImageBlock";

// ===== 工具状态 / 视图模型 =====

export interface ToolCallView {
	callId: string;
	toolName: string;
	args: Record<string, unknown>;
	status: "pending" | "running" | "success" | "error";
	result: unknown;
	isError: boolean | undefined;
}

/** 工具状态推导（两条路径共用的同一套规则）。 */
function statusFor(
	block: UnifiedBlock,
	toolExecutions: Record<string, LookUiToolExecState>,
	toolResultMap: Record<string, ToolResultMessage> | undefined,
	defaultToolStatus: "pending" | "running",
): "pending" | "running" | "success" | "error" {
	const execution = block.toolCallId ? toolExecutions[block.toolCallId] : undefined;
	if (execution) {
		return execution.phase === "running" ? "running" : execution.isError ? "error" : "success";
	}
	const persisted = block.toolCallId ? toolResultMap?.[block.toolCallId] : undefined;
	if (persisted) {
		return persisted.isError ? "error" : "success";
	}
	return defaultToolStatus;
}

/** 文本块的流式效果：快照源（completed 恒 undefined）跟随全局 isStreaming；流式源看未完成。 */
function isTextStreaming(block: UnifiedBlock, isStreaming: boolean): boolean {
	if (!isStreaming) return false;
	if (block.completed !== undefined) return !block.completed;
	return true;
}

/** thinking 块的流式效果：快照源只在最后一块 active；流式源看未完成。 */
function isThinkingStreaming(block: UnifiedBlock, isStreaming: boolean, totalBlocks: number): boolean {
	if (!isStreaming) return false;
	if (block.completed !== undefined) return !block.completed;
	return block.sourceIndex === totalBlocks - 1;
}

// ===== Per-block memo 视图 =====

interface UnifiedBlockViewProps {
	block: UnifiedBlock;
	isStreaming: boolean;
	autoCollapse: boolean;
	toolExecution: LookUiToolExecState | undefined;
	/** thinking 块是否处于「流式激活」状态（父级已按源类型计算好）。
	 *  快照源：isStreaming && 是最后一块；流式源：isStreaming && !completed。
	 *  作为布尔 prop 传入，避免 totalBlocks 变化击穿所有 block 的 memo。 */
	thinkingStreaming: boolean;
}

/**
 * Per-block memo 视图：key 用 UnifiedBlock.key（流式 uid / 快照 hash）。
 * 当流式 delta 更新时，只有引用变化的 block（以及其 toolExecution）
 * 会重渲染。
 */
const UnifiedBlockView = memo(function UnifiedBlockView({
	block,
	isStreaming,
	autoCollapse,
	toolExecution,
	thinkingStreaming,
}: UnifiedBlockViewProps) {
	switch (block.kind) {
		case "text": {
			if (!block.text) return null;
			return (
				<div className="message-prose">
					<SkillAwareContent content={block.text} isStreaming={isTextStreaming(block, isStreaming)} />
				</div>
			);
		}
		case "thinking": {
			// ThinkingPanel 自身处理空 thinking（空+非流式 → null，空+流式 → 骨架），
			// 这里不再重复拦截，保持单一职责。
			return (
				<ThinkingPanel
					thinking={block.thinking ?? ""}
					isStreaming={thinkingStreaming}
					autoCollapse={autoCollapse}
				/>
			);
		}
		case "image": {
			if (!block.image) return null;
			return <ImageBlock block={block.image} />;
		}
		case "toolcall": {
			// 防御性兜底：normal toolcall 恒被 segmentExecutionBlocks 归入 group，
			// 此分支理论上不可达；保留以覆盖未知 future 分段变化。
			return (
				<ToolCallCard
					toolCall={{
						callId: block.toolCallId ?? "",
						toolName: block.toolName ?? "unknown",
						args: block.args ?? {},
						status: toolExecution
							? toolExecution.phase === "running"
								? "running"
								: toolExecution.isError
									? "error"
									: "success"
							: "running",
						result: toolExecution?.result ?? toolExecution?.partialResult,
						isError: toolExecution?.isError,
					}}
				/>
			);
		}
		default:
			return null;
	}
});

// ===== Group / subagent 转换 =====

/**
 * 把 group 段内的 UnifiedBlock 转回 pi-ai content block 形状，
 * 供 CollapsibleExecutionGroup 消费（与旧流式路径的转换一致）。
 */
function toContentBlocks(blocks: UnifiedBlock[]): Array<ThinkingContent | ToolCall> {
	return blocks.map((b) =>
		b.kind === "thinking"
			? ({ type: "thinking", thinking: b.thinking ?? "", thinkingSignature: b.thinkingSignature } as ThinkingContent)
			: ({
					type: "toolCall",
					id: b.toolCallId ?? "",
					name: b.toolName ?? "unknown",
					arguments: b.args ?? {},
				} as ToolCall),
	);
}

/** SubagentToolGroup 消费的 ToolCallViewModel 数组。 */
function toToolCallViews(
	blocks: UnifiedBlock[],
	toolExecutions: Record<string, LookUiToolExecState>,
	toolResultMap: Record<string, ToolResultMessage> | undefined,
	defaultToolStatus: "pending" | "running",
): ToolCallView[] {
	return blocks.map((b) => {
		const execution = b.toolCallId ? toolExecutions[b.toolCallId] : undefined;
		return {
			callId: b.toolCallId ?? "",
			toolName: b.toolName ?? "unknown",
			args: b.args ?? {},
			status: statusFor(b, toolExecutions, toolResultMap, defaultToolStatus),
			result: execution?.result ?? execution?.partialResult,
			isError: execution?.isError,
		};
	});
}

// ===== 统一渲染器 =====

export interface MessageBlockListProps {
	/** 归一后的消息块（快照源或流式源）。 */
	blocks: UnifiedBlock[];
	isStreaming: boolean;
	autoCollapse: boolean;
	toolExecutions: Record<string, LookUiToolExecState>;
	toolResultMap?: Record<string, ToolResultMessage>;
	/** 无 execution 也无 persisted result 时工具的默认状态：快照 pending / 流式 running。 */
	defaultToolStatus: "pending" | "running";
}

export const MessageBlockList = memo(function MessageBlockList({
	blocks,
	isStreaming,
	autoCollapse,
	toolExecutions,
	toolResultMap,
	defaultToolStatus,
}: MessageBlockListProps) {
	// 设置「显示工具组」关闭时：完全隐藏工具调用与思考块，只保留文本/图片。
	// 用户选择关闭后消息流只显示最终回答，不展示任何执行细节。
	const showToolExecution = useAtomValue(showToolExecutionAtom);
	const visibleBlocks = showToolExecution ? blocks : blocks.filter((b) => b.kind === "text" || b.kind === "image");

	if (visibleBlocks.length === 0) return null;

	// 单次分段：连续 thinking/toolcall 组成折叠组；subagent 类单独成组。
	// 编辑类工具也归入折叠组（展开后卡内展示 diff 预览）。
	const segments = segmentExecutionBlocks(
		visibleBlocks,
		(b) => b.kind === "thinking" || b.kind === "toolcall",
		(b) => b.kind === "toolcall" && isSubagentTool(b.toolName ?? ""),
	);

	return (
		<div className="flex flex-col gap-msg-block">
			{segments.map((seg, segIdx) => {
				if (seg.kind === "single") {
					const block = seg.block;
					return (
						<UnifiedBlockView
							key={block.key}
							block={block}
							isStreaming={isStreaming}
							autoCollapse={autoCollapse}
							toolExecution={
								block.kind === "toolcall" && block.toolCallId ? toolExecutions[block.toolCallId] : undefined
							}
							thinkingStreaming={isThinkingStreaming(block, isStreaming, blocks.length)}
						/>
					);
				}

				if (seg.kind === "subagent") {
					return (
						<SubagentToolGroup
							key={`subagents-${seg.startIndex}-${segIdx}`}
							calls={toToolCallViews(seg.blocks, toolExecutions, toolResultMap, defaultToolStatus)}
						/>
					);
				}

				const groupEndIndex = seg.startIndex + seg.blocks.length;
				const isActiveGroup = isStreaming && groupEndIndex === blocks.length;
				return (
					<CollapsibleExecutionGroup
						key={`group-${seg.startIndex}-${segIdx}`}
						blocks={toContentBlocks(seg.blocks)}
						toolExecutions={toolExecutions}
						toolResultMap={toolResultMap}
						isStreaming={isActiveGroup}
					/>
				);
			})}
		</div>
	);
});
