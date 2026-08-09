// ============================================================
// StreamingBlocksBubble — 流式块气泡内容（独立文件避免循环依赖）
//
// 流式期间先渲染内容块（MessageBlockList），状态行（九宫格顺时针
// + 阶段状态文字 + 计时）保持在输出内容之后的一行：
//   - blocks 为空：只有状态行（thinking）
//   - 工具/思考阶段：工具组 / 思考面板在上，状态行跟随其后
//   - 正文输出阶段：正文渲染在上，状态行在正文下一行
// 非流式：空块返回 null，非空用统一渲染器 MessageBlockList。
// ============================================================

import type { LookUiStreamBlock, LookUiToolExecState } from "@shared/types";
import { memo, useMemo } from "react";
import { toUnifiedFromStream } from "./block-renderer/blockTypes";
import { MessageBlockList } from "./block-renderer/MessageBlockList";
import { StreamingStatusBar, streamingPhase } from "./StreamingStatusBar";

export const StreamingBlocksBubble = memo(function StreamingBlocksBubble({
	blocks,
	toolExecutions,
	isStreaming,
	autoCollapse,
}: {
	blocks: LookUiStreamBlock[];
	toolExecutions: Record<string, LookUiToolExecState>;
	isStreaming: boolean;
	autoCollapse: boolean;
}) {
	const unified = useMemo(() => toUnifiedFromStream(blocks), [blocks]);
	const phase = streamingPhase(blocks, isStreaming);

	if (!isStreaming) {
		if (blocks.length === 0) return null;
		return (
			<MessageBlockList
				blocks={unified}
				isStreaming={false}
				autoCollapse={autoCollapse}
				toolExecutions={toolExecutions}
				// 完成态（短暂窗口）语义与快照一致：无 execution 的 subagent 显示 pending，
				// 不再显示 running spinner（与 CEG 的 statusFor 默认 pending 统一）。
				defaultToolStatus="pending"
			/>
		);
	}

	return (
		<div className="flex flex-col gap-1.5">
			{blocks.length > 0 && (
				<MessageBlockList
					blocks={unified}
					isStreaming={true}
					autoCollapse={autoCollapse}
					toolExecutions={toolExecutions}
					defaultToolStatus="running"
				/>
			)}
			{phase && <StreamingStatusBar phase={phase} />}
		</div>
	);
});
