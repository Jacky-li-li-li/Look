import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { cn } from "@look/ui";
import { UserAvatar } from "@look/ui/components/UserAvatar";
import type { LookUiStreamBlock, LookUiToolExecState } from "@shared/types";
import { useAtomValue } from "jotai";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { userProfileAtom } from "../../store/authAtoms";
import { AiAvatar } from "../AiAvatar";
import { toUnifiedFromPiAi, toUnifiedFromStream } from "./block-renderer/blockTypes";
import { MessageBlockList } from "./block-renderer/MessageBlockList";
import { MessageHeader } from "./message-elements/MessageElements";

interface MessageBubbleProps {
	message: AgentMessage;
	agentName?: string;
	isStreaming?: boolean;
	autoCollapse: boolean;
	toolExecutions: Record<string, LookUiToolExecState>;
	toolResultMap?: Record<string, ToolResultMessage>;
	isActiveLeaf?: boolean;
	flash?: boolean;
	liveBlocks?: LookUiStreamBlock[];
	liveToolExecutions?: Record<string, LookUiToolExecState>;
}

function resultText(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && "content" in value && Array.isArray(value.content)) {
		const text = value.content
			.filter((block): block is TextContent => block?.type === "text")
			.map((block) => block.text)
			.join("\n");
		if (text) return text;
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function ContentBlocks({
	blocks,
	isStreaming,
	autoCollapse,
	toolExecutions,
	toolResultMap,
}: {
	blocks: Array<TextContent | ThinkingContent | ImageContent | ToolCall>;
	isStreaming: boolean;
	autoCollapse: boolean;
	toolExecutions: Record<string, LookUiToolExecState>;
	toolResultMap?: Record<string, ToolResultMessage>;
}) {
	const unified = useMemo(() => toUnifiedFromPiAi(blocks), [blocks]);
	return (
		<MessageBlockList
			blocks={unified}
			isStreaming={isStreaming}
			autoCollapse={autoCollapse}
			toolExecutions={toolExecutions}
			toolResultMap={toolResultMap}
			defaultToolStatus="pending"
		/>
	);
}

function messageBlocks(message: AgentMessage): Array<TextContent | ThinkingContent | ImageContent | ToolCall> {
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

const MessageBubble = memo(function MessageBubble({
	message,
	agentName,
	isStreaming = false,
	autoCollapse,
	toolExecutions,
	toolResultMap,
	isActiveLeaf = false,
	flash = false,
	liveBlocks,
	liveToolExecutions,
}: MessageBubbleProps) {
	const { t } = useTranslation();
	const userProfile = useAtomValue(userProfileAtom);
	const isUser = message.role === "user";
	const assistant = message.role === "assistant" ? (message as AssistantMessage) : null;
	const sender = isUser
		? userProfile.userName || t("chat.you")
		: message.role === "custom"
			? message.customType
			: message.role === "bashExecution"
				? "bash"
				: (agentName ?? t("chat.agent"));

	const derivedBlocks = useMemo(() => messageBlocks(message), [message]);

	return (
		<div
			className={cn("flex gap-msg-bubble", isUser && "flex-row-reverse self-end")}
			style={{ maxWidth: isUser ? "90%" : "98%" }}
		>
			{isUser ? (
				<UserAvatar avatar={userProfile.avatar} size="sm" className="mt-msg-avatar" />
			) : (
				<AiAvatar size="sm" className="mt-msg-avatar shrink-0" />
			)}
			<div className="min-w-0 flex-1">
				<MessageHeader sender={sender} isStreaming={isStreaming} isActiveLeaf={isActiveLeaf} isUser={isUser} />
				<div
					className={cn(
						"whisper-bubble flex flex-col gap-msg-block text-[var(--prose-font-size)] leading-[var(--prose-line-height)]",
						isUser ? "whisper-bubble--user" : "whisper-bubble--assistant w-full",
						flash && "bubble-flash",
					)}
				>
					{liveBlocks && liveBlocks.length > 0 ? (
						<StreamingBlocksBubble
							blocks={liveBlocks}
							toolExecutions={liveToolExecutions ?? {}}
							isStreaming={isStreaming}
							autoCollapse={autoCollapse}
						/>
					) : (
						<ContentBlocks
							blocks={derivedBlocks}
							isStreaming={isStreaming}
							autoCollapse={autoCollapse}
							toolExecutions={toolExecutions}
							toolResultMap={toolResultMap}
						/>
					)}
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
				</div>
			</div>
		</div>
	);
});

// ============================================================
// Streaming blocks rendering — discrete-event path
// ============================================================

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
	const { t } = useTranslation();

	return (
		<div className="flex gap-msg-bubble" style={{ maxWidth: "98%" }}>
			<AiAvatar size="sm" className="mt-msg-avatar shrink-0" />
			<div className="min-w-0 flex-1">
				<MessageHeader
					sender={agentName ?? t("chat.agent")}
					isStreaming={isStreaming}
					isActiveLeaf={false}
					isUser={false}
				/>
				<div className="whisper-bubble whisper-bubble--assistant w-full flex flex-col gap-msg-block text-[var(--prose-font-size)] leading-[var(--prose-line-height)]">
					<StreamingBlocksBubble
						blocks={blocks}
						toolExecutions={toolExecutions}
						isStreaming={isStreaming}
						autoCollapse={autoCollapse}
					/>
				</div>
			</div>
		</div>
	);
});

export default MessageBubble;
