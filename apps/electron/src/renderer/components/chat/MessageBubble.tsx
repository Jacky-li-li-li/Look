// ============================================================
// MessageBubble — 兼容转发壳
//
// 新组装逻辑在 MessageItem.tsx（message-elements 原语 + 统一块渲染器）。
// 本文件保留 default export / StreamingMessageBubble 导出名，兼容既有
// import 调用方，避免大范围改调用点。
// ============================================================

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { LookUiStreamBlock, LookUiToolExecState } from "@shared/types";
import { memo } from "react";
import { MessageItem, type MessageItemProps } from "./MessageItem";

export { StreamingBlocksBubble } from "./StreamingBlocksBubble";

interface MessageBubbleProps extends Omit<MessageItemProps, "message" | "liveBlocks"> {
	message: AgentMessage;
	liveBlocks?: LookUiStreamBlock[];
}

const MessageBubble = memo(function MessageBubble(props: MessageBubbleProps) {
	return <MessageItem {...props} />;
});

// ── 纯 live 消息（无持久化 message）──

interface StreamingMessageBubbleProps {
	agentName?: string;
	blocks: LookUiStreamBlock[];
	toolExecutions: Record<string, LookUiToolExecState>;
	isStreaming: boolean;
	autoCollapse: boolean;
}

export const StreamingMessageBubble = memo(function StreamingMessageBubble({
	agentName,
	blocks,
	toolExecutions,
	isStreaming,
	autoCollapse,
}: StreamingMessageBubbleProps) {
	return (
		<MessageItem
			agentName={agentName}
			liveBlocks={blocks}
			liveToolExecutions={toolExecutions}
			isStreaming={isStreaming}
			autoCollapse={autoCollapse}
		/>
	);
});

export default MessageBubble;
