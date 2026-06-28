import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { cn } from "@shared/lib/utils";
import type { LookUiStreamBlock, LookUiToolExecState, SessionEntry } from "@shared/types";
import { useAtomValue } from "jotai";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { userProfileAtom } from "../store/authAtoms";
import CollapsibleExecutionGroup from "./CollapsibleExecutionGroup";
import { PixelAgentAvatar } from "./PixelAgentAvatar";
import SkillAwareContent from "./SkillAwareContent";
import ThinkingPanel from "./ThinkingPanel";
import ToolCallCard from "./ToolCallCard";
import UserAvatar from "./UserAvatar";

interface MessageBubbleProps {
	message: AgentMessage;
	agentName?: string;
	isStreaming?: boolean;
	autoCollapse: boolean;
	toolExecutions: Record<string, LookUiToolExecState>;
	toolResultMap?: Record<string, ToolResultMessage>;
	isActiveLeaf?: boolean;
	flash?: boolean;
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

function ImageBlock({ block }: { block: ImageContent }) {
	return (
		<img
			src={`data:${block.mimeType};base64,${block.data}`}
			alt="SDK message attachment"
			className="max-h-48 max-w-64 rounded-md border border-hairline object-contain"
		/>
	);
}

function MessageHeader({
	sender,
	isStreaming,
	isActiveLeaf,
	isUser,
}: {
	sender: string;
	isStreaming: boolean;
	isActiveLeaf: boolean;
	isUser: boolean;
}) {
	return (
		<div className={cn("mb-0.5 flex items-center gap-2 text-[10px] text-muted-foreground", isUser && "justify-end")}>
			<span className="font-medium uppercase tracking-wider">{sender}</span>
			{isStreaming && <span className="status-mark" data-status="thinking" />}
		</div>
	);
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
	// Simple adjacent grouping: a group is just a run of consecutive
	// (thinking | toolCall) blocks. Text blocks are always rendered
	// standalone and never absorbed into a group, so user-written notes
	// between tool calls stay visible at all times.
	type Segment =
		| { kind: "single"; block: TextContent | ThinkingContent | ImageContent | ToolCall; index: number }
		| { kind: "group"; blocks: Array<ThinkingContent | ToolCall>; startIndex: number };

	const segments: Segment[] = [];
	let i = 0;
	while (i < blocks.length) {
		const b = blocks[i];
		if (b.type === "thinking" || b.type === "toolCall") {
			const startIndex = i;
			const groupBlocks: Array<ThinkingContent | ToolCall> = [];
			while (i < blocks.length && (blocks[i].type === "thinking" || blocks[i].type === "toolCall")) {
				groupBlocks.push(blocks[i] as ThinkingContent | ToolCall);
				i++;
			}
			segments.push({ kind: "group", blocks: groupBlocks, startIndex });
		} else {
			segments.push({ kind: "single", block: b, index: i });
			i++;
		}
	}

	return (
		<div className="flex flex-col gap-1.5">
			{segments.map((seg, segIdx) => {
				if (seg.kind === "single") {
					const block = seg.block;
					const index = seg.index;
					if (block.type === "text") {
						if (!block.text) return null;
						return (
							<div key={`text-${index}`} className="message-prose">
								<SkillAwareContent content={block.text} isStreaming={isStreaming} />
							</div>
						);
					}
					if (block.type === "thinking") {
						if (!block.thinking) return null;
						return (
							<ThinkingPanel
								key={`thinking-${index}`}
								thinking={block.thinking}
								isStreaming={isStreaming}
								autoCollapse={autoCollapse}
							/>
						);
					}
					if (block.type === "image") return <ImageBlock key={`image-${index}`} block={block} />;

					const execution = toolExecutions[block.id];
					const persistedResult = toolResultMap?.[block.id];

					const status = execution
						? execution.phase === "running"
							? "running"
							: execution.isError
								? "error"
								: "success"
						: persistedResult
							? persistedResult.isError
								? "error"
								: "success"
							: "pending";

					const result = execution
						? (execution.result ?? execution.partialResult)
						: persistedResult?.content;

					return (
						<ToolCallCard
							key={block.id || `tool-${index}`}
							toolCall={{
								callId: block.id,
								toolName: block.name,
								args: block.arguments,
								status,
								result,
								isError: execution?.isError ?? persistedResult?.isError,
							}}
						/>
					);
				}

				return (
					<CollapsibleExecutionGroup
						key={`group-${seg.startIndex}-${segIdx}`}
						blocks={seg.blocks}
						toolExecutions={toolExecutions}
						toolResultMap={toolResultMap}
						isStreaming={isStreaming}
					/>
				);
			})}
		</div>
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

	return (
		<div
			className={cn("flex gap-3", isUser && "flex-row-reverse self-end")}
			style={{ maxWidth: isUser ? "90%" : "98%" }}
		>
			{isUser ? (
				<UserAvatar avatar={userProfile.avatar} size="sm" className="mt-0.5" />
			) : (
				<PixelAgentAvatar size="sm" className="mt-0.5 shrink-0" />
			)}
			<div className="min-w-0 flex-1">
				<MessageHeader sender={sender} isStreaming={isStreaming} isActiveLeaf={isActiveLeaf} isUser={isUser} />
				<div
					className={cn(
						"whisper-bubble flex flex-col gap-1.5 text-[13px] leading-relaxed",
						isUser ? "whisper-bubble--user" : "whisper-bubble--assistant w-full",
						flash && "bubble-flash",
					)}
				>
					<ContentBlocks
						blocks={messageBlocks(message)}
						isStreaming={isStreaming}
						autoCollapse={autoCollapse}
						toolExecutions={toolExecutions}
						toolResultMap={toolResultMap}
					/>
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

export function SessionEntryBubble({ entry }: { entry: Exclude<SessionEntry, { type: "message" }> }) {
	let title: string = entry.type;
	let body = "";
	if (entry.type === "branch_summary" || entry.type === "compaction") body = entry.summary;
	else if (entry.type === "custom_message")
		body = typeof entry.content === "string" ? entry.content : (resultText(entry.content) ?? "");
	else if (entry.type === "model_change") body = `${entry.provider}/${entry.modelId}`;
	else if (entry.type === "thinking_level_change") body = entry.thinkingLevel;
	else if (entry.type === "label") body = entry.label ?? "";
	else if (entry.type === "session_info") body = entry.name ?? "";
	else if (entry.type === "custom") body = resultText(entry.data) ?? "";
	if (entry.type === "custom_message") title = entry.customType;
	return (
		<div className="mx-10 rounded-md border border-hairline bg-muted/20 px-3 py-2 text-xs">
			<div className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
			{body && <div className="message-prose whitespace-pre-wrap">{body}</div>}
		</div>
	);
}

// ============================================================
// Streaming blocks rendering — discrete-event path
// ============================================================

interface StreamingBlocksBubbleProps {
	blocks: LookUiStreamBlock[];
	toolExecutions: Record<string, LookUiToolExecState>;
	isStreaming: boolean;
	autoCollapse: boolean;
}

export const StreamingBlocksBubble = memo(function StreamingBlocksBubble({
	blocks,
	toolExecutions,
	isStreaming,
	autoCollapse,
}: StreamingBlocksBubbleProps) {
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
		<div className="flex flex-col gap-1.5">
			{blocks.map((block, idx) => {
				if (block.kind === "text") {
					if (!block.text) return null;
					return (
						<div key={`txt-${idx}`} className="message-prose">
							<SkillAwareContent content={block.text} isStreaming={isStreaming && !block.completed} />
						</div>
					);
				}
				if (block.kind === "thinking") {
					// Let ThinkingPanel decide — it shows a loading indicator
					// when streaming with empty content.
					return (
						<ThinkingPanel
							key={`think-${idx}`}
							thinking={block.thinking}
							isStreaming={isStreaming && !block.completed}
							autoCollapse={autoCollapse}
						/>
					);
				}
				if (block.kind === "toolcall") {
					const exec = block.toolCallId ? toolExecutions[block.toolCallId] : undefined;
					const s = exec
						? exec.phase === "running"
							? "running"
							: exec.isError
								? "error"
								: "success"
						: block.completed
							? "success"
							: "pending";
					return (
						<ToolCallCard
							key={`tool-${idx}`}
							toolCall={{
								callId: block.toolCallId ?? "",
								toolName: block.toolName ?? "unknown",
								args: block.args ?? {},
								status: s,
								result: exec?.result,
								isError: exec?.isError,
							}}
						/>
					);
				}
				if (block.kind === "image") {
					if (!block.image) return null;
					return <ImageBlock key={`img-${idx}`} block={block.image} />;
				}
				return null;
			})}
		</div>
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
		<div className="flex gap-3" style={{ maxWidth: "98%" }}>
			<PixelAgentAvatar size="sm" className="mt-0.5 shrink-0" />
			<div className="min-w-0 flex-1">
				<MessageHeader
					sender={agentName ?? t("chat.agent")}
					isStreaming={isStreaming}
					isActiveLeaf={false}
					isUser={false}
				/>
				<div className="whisper-bubble whisper-bubble--assistant w-full flex flex-col gap-1.5">
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
