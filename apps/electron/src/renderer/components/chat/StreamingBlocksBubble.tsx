// ============================================================
// StreamingBlocksBubble — 流式块气泡内容（独立文件避免循环依赖）
//
// 空块时显示流式加载指示；非空时用统一渲染器 MessageBlockList
// 渲染（defaultToolStatus="running"：toolcall_end 可能先于
// tool_exec_start 到达）。
// ============================================================

import type { LookUiStreamBlock, LookUiToolExecState } from "@shared/types";
import { memo, useMemo } from "react";
import { toUnifiedFromStream } from "./block-renderer/blockTypes";
import { MessageBlockList } from "./block-renderer/MessageBlockList";

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

	if (blocks.length === 0) {
		// Show a loading indicator while the first streaming blocks are arriving.
		// This prevents the bubble from appearing empty between assistant_message_start
		// and the first text_start / text_delta events.
		if (isStreaming) {
			return (
				<div className="flex items-center gap-2 text-muted-foreground text-sm py-1">
					<span className="inline-block w-2 h-4 bg-primary animate-pulse rounded-xs" />
					<span>Thinking…</span>
				</div>
			);
		}
		return null;
	}

	return (
		<MessageBlockList
			blocks={unified}
			isStreaming={isStreaming}
			autoCollapse={autoCollapse}
			toolExecutions={toolExecutions}
			defaultToolStatus="running"
		/>
	);
});
