// ============================================================
// MessageItem — 单条消息组装层（对标 Proma ChatMessageItem）
//
// 用 message-elements 原语（MessageRoot / MessageAvatar / MessageHeader /
// MessageContent）组装一条完整消息。统一三种来源：
//   - 持久化 message（快照路径）
//   - live message（快照 + 流式块同存）
//   - 纯 live（无 message，仅 uiBlocks）
// 流式与否是同一组件的 prop 状态，而非另一棵树。
// ============================================================

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { LookUiStreamBlock, LookUiToolExecState } from "@shared/types";
import { useAtomValue } from "jotai";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { userProfileAtom } from "../../store/authAtoms";
import { StreamingBlocksBubble } from "./MessageBubble";
import { MessageAvatar, MessageContent, MessageHeader, MessageRoot } from "./message-elements/MessageElements";

export interface MessageItemProps {
	/** 持久化消息（纯 live 时为 undefined）。 */
	message?: AgentMessage;
	agentName?: string;
	isStreaming?: boolean;
	autoCollapse: boolean;
	toolExecutions?: Record<string, LookUiToolExecState>;
	toolResultMap?: Record<string, unknown>;
	isActiveLeaf?: boolean;
	flash?: boolean;
	/** 流式块（live 消息时传入；纯 live 时 message 为 undefined）。 */
	liveBlocks?: LookUiStreamBlock[];
	liveToolExecutions?: Record<string, LookUiToolExecState>;
}

function senderFor(
	message: AgentMessage | undefined,
	agentName: string | undefined,
	userName: string,
	fallbackAgent: string,
): string {
	if (!message) return agentName ?? fallbackAgent;
	if (message.role === "user") return userName;
	if (message.role === "custom") return message.customType;
	if (message.role === "bashExecution") return "bash";
	return agentName ?? fallbackAgent;
}

export const MessageItem = memo(function MessageItem({
	message,
	agentName,
	isStreaming = false,
	autoCollapse,
	toolExecutions = {},
	toolResultMap,
	isActiveLeaf = false,
	flash = false,
	liveBlocks,
	liveToolExecutions = {},
}: MessageItemProps) {
	const { t } = useTranslation();
	const userProfile = useAtomValue(userProfileAtom);

	const isUser = message?.role === "user";
	const assistant = message?.role === "assistant" ? (message as AssistantMessage) : null;
	const sender = senderFor(message, agentName, userProfile.userName || t("chat.you"), t("chat.agent"));

	const hasLive = Boolean(liveBlocks && liveBlocks.length > 0);

	return (
		<MessageRoot from={isUser ? "user" : "assistant"}>
			<MessageAvatar from={isUser ? "user" : "assistant"} userAvatar={userProfile.avatar} />
			<div className="min-w-0 flex-1">
				<MessageHeader sender={sender} isStreaming={isStreaming} isActiveLeaf={isActiveLeaf} isUser={isUser} />
				<MessageContent isUser={isUser} flash={flash}>
					{hasLive ? (
						<StreamingBlocksBubble
							blocks={liveBlocks ?? []}
							toolExecutions={liveToolExecutions}
							isStreaming={isStreaming}
							autoCollapse={autoCollapse}
						/>
					) : message ? (
						<MessageBlockListForMessage
							message={message}
							isStreaming={isStreaming}
							autoCollapse={autoCollapse}
							toolExecutions={toolExecutions}
							toolResultMap={toolResultMap}
						/>
					) : null}
					{assistant?.errorMessage && <div className="text-destructive">{assistant.errorMessage}</div>}
					{assistant && assistant.stopReason !== "stop" && assistant.stopReason !== "toolUse" && (
						<div className="text-[10px] uppercase tracking-wide text-muted-foreground">
							{assistant.stopReason}
						</div>
					)}
					{assistant?.diagnostics && assistant.diagnostics.length > 0 && (
						<details className="mt-1 text-[10px] text-muted-foreground/60">
							<summary className="cursor-pointer">diagnostics ({assistant.diagnostics.length})</summary>
							<pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[9px]">
								{JSON.stringify(assistant.diagnostics, null, 2)}
							</pre>
						</details>
					)}
				</MessageContent>
			</div>
		</MessageRoot>
	);
});

// 保持与 MessageBubble 相同的内容块渲染：快照路径用 MessageBlockList。
import { useMemo } from "react";
import { toUnifiedFromPiAi } from "./block-renderer/blockTypes";
import { MessageBlockList } from "./block-renderer/MessageBlockList";

function MessageBlockListForMessage({
	message,
	isStreaming,
	autoCollapse,
	toolExecutions,
	toolResultMap,
}: {
	message: AgentMessage;
	isStreaming: boolean;
	autoCollapse: boolean;
	toolExecutions: Record<string, LookUiToolExecState>;
	toolResultMap?: Record<string, unknown>;
}) {
	const blocks = useMemo(() => messageBlocks(message), [message]);
	const unified = useMemo(() => toUnifiedFromPiAi(blocks), [blocks]);
	return (
		<MessageBlockList
			blocks={unified}
			isStreaming={isStreaming}
			autoCollapse={autoCollapse}
			toolExecutions={toolExecutions}
			toolResultMap={toolResultMap as never}
			defaultToolStatus="pending"
		/>
	);
}

function messageBlocks(
	message: AgentMessage,
): Array<
	| import("@earendil-works/pi-ai").TextContent
	| import("@earendil-works/pi-ai").ThinkingContent
	| import("@earendil-works/pi-ai").ImageContent
	| import("@earendil-works/pi-ai").ToolCall
> {
	if (message.role === "assistant") return [...message.content];
	if (message.role === "user") {
		return typeof message.content === "string" ? [{ type: "text", text: message.content }] : [...message.content];
	}
	if (message.role === "custom") {
		return typeof message.content === "string" ? [{ type: "text", text: message.content }] : [...message.content];
	}
	if (message.role === "bashExecution") {
		return [{ type: "text", text: `$ ${message.command}\n${message.output}` }];
	}
	if (message.role === "branchSummary" || message.role === "compactionSummary") {
		return [{ type: "text", text: message.summary }];
	}
	return [{ type: "text", text: resultText(message) ?? "" }];
}

function resultText(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && "content" in value && Array.isArray(value.content)) {
		const text = value.content
			.filter((block): block is TextContent => (block as { type?: string })?.type === "text")
			.map((block) => (block as { text?: string }).text)
			.join("\n");
		if (text) return text;
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}
