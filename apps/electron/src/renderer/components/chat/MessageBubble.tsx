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
import type { LookUiStreamBlock, LookUiToolExecState, SessionEntry } from "@shared/types";
import { useAtomValue } from "jotai";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { segmentExecutionBlocks } from "../../lib/executionSegments";
import { hashKey } from "../../lib/stableKey";
import { userProfileAtom } from "../../store/authAtoms";
import { AiAvatar } from "../AiAvatar";
import CollapsibleExecutionGroup from "./CollapsibleExecutionGroup";
import SkillAwareContent from "./SkillAwareContent";
import { isSubagentTool } from "./SubagentArgsCards";
import SubagentToolGroup from "./SubagentToolGroup";
import ThinkingPanel from "./ThinkingPanel";
import ToolCallCard from "./ToolCallCard";

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

function ImageBlock({ block }: { block: ImageContent }) {
	return (
		<img
			src={`data:${block.mimeType};base64,${block.data}`}
			alt="SDK message attachment"
			className="max-h-48 max-w-64 rounded-md border border-hairline object-contain"
		/>
	);
}

/**
 * Parse a JSON string that may be incomplete (the SDK streams tool-call
 * arguments in pieces). Returns whatever object it can extract — keys for
 * already-completed fields are present, the in-progress last field is
 * dropped if it can't be parsed. Used to give live tool cards a useful
 * `formatToolSummary` before the SDK sends the parsed final args.
 */
function safelyParsePartialJson(raw: string): Record<string, unknown> | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	// Try the whole string first (it's complete).
	try {
		const v = JSON.parse(trimmed);
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
	} catch {
		// Fall through.
	}
	// Trim back to the last completed `"key": value,` so the trailing partial
	// field is dropped. We scan for unescaped quotes to find a safe prefix.
	let lastSafe = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
		}
		if (!inString && (ch === "," || ch === "}")) {
			lastSafe = i;
		}
	}
	if (lastSafe < 0) return undefined;
	const prefix = `${trimmed.slice(0, lastSafe)}}`;
	try {
		const v = JSON.parse(prefix);
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
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
		<div
			className={cn(
				"mb-msg-header flex items-center gap-2 text-[10px] text-muted-foreground",
				isUser && "justify-end",
			)}
		>
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
	// Adjacent grouping via shared segmenter: runs of consecutive
	// (thinking | toolCall) blocks form a collapsible group, except
	// subagent-class tool calls, which are carved out into their own
	// always-visible card section (SubagentToolGroup). Text blocks are
	// always rendered standalone and never absorbed into a group, so
	// user-written notes between tool calls stay visible at all times.
	const segments = segmentExecutionBlocks(
		blocks,
		(b) => b.type === "thinking" || b.type === "toolCall",
		(b) => b.type === "toolCall" && isSubagentTool(b.name),
	);

	// Pre-compute a stable ToolCallViewModel per toolCall block. Without this memo
	// the inline `{ ... }` literal at the ToolCallCard call site creates a new
	// object reference every render, defeating ToolCallCard's memo comparator and
	// forcing the card subtree to re-render on every streaming delta.
	const toolCallViews = useMemo(() => {
		const map = new Map<
			string,
			{
				callId: string;
				toolName: string;
				args: Record<string, unknown>;
				status: "pending" | "running" | "success" | "error";
				result: unknown;
				isError: boolean | undefined;
			}
		>();
		for (const block of blocks) {
			if (block.type !== "toolCall") continue;
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
			const result = execution ? (execution.result ?? execution.partialResult) : persistedResult?.content;
			map.set(block.id || `tool-${block.name}-${hashKey(JSON.stringify(block.arguments ?? {}))}`, {
				callId: block.id,
				toolName: block.name,
				args: block.arguments,
				status,
				result,
				isError: execution?.isError ?? persistedResult?.isError,
			});
		}
		return map;
	}, [blocks, toolExecutions, toolResultMap]);

	return (
		<div className="flex flex-col gap-msg-block">
			{segments.map((seg, segIdx) => {
				if (seg.kind === "single") {
					const block = seg.block;
					if (block.type === "text") {
						if (!block.text) return null;
						return (
							<div key={`text-${hashKey(block.text)}`} className="message-prose">
								<SkillAwareContent content={block.text} isStreaming={isStreaming} />
							</div>
						);
					}
					if (block.type === "thinking") {
						if (!block.thinking) return null;
						const isActiveThinking = isStreaming && seg.index === blocks.length - 1;
						return (
							<ThinkingPanel
								key={`thinking-${hashKey(block.thinking)}`}
								thinking={block.thinking}
								isStreaming={isActiveThinking}
								autoCollapse={autoCollapse}
							/>
						);
					}
					if (block.type === "image") return <ImageBlock key={`image-${hashKey(block.data)}`} block={block} />;
					if (block.type === "toolCall") {
						const viewKey = block.id || `tool-${block.name}-${hashKey(JSON.stringify(block.arguments ?? {}))}`;
						const toolCallView = toolCallViews.get(viewKey);

						return (
							<ToolCallCard
								key={viewKey}
								toolCall={
									toolCallView ?? {
										callId: block.id,
										toolName: block.name,
										args: block.arguments,
										status: "pending",
										result: undefined,
										isError: undefined,
									}
								}
							/>
						);
					}
					// Unknown block type — should not reach here.
					const unknownBlock = block as { type?: string };
					console.warn(`[ContentBlocks] Unknown block type: ${unknownBlock.type ?? "undefined"}`);
					return null;
				}

				if (seg.kind === "subagent") {
					const calls = (seg.blocks as ToolCall[]).map((block) => {
						const viewKey = block.id || `tool-${block.name}-${hashKey(JSON.stringify(block.arguments ?? {}))}`;
						return (
							toolCallViews.get(viewKey) ?? {
								callId: block.id,
								toolName: block.name,
								args: block.arguments,
								status: "pending" as const,
								result: undefined,
								isError: undefined,
							}
						);
					});
					return <SubagentToolGroup key={`subagents-${seg.startIndex}-${segIdx}`} calls={calls} />;
				}

				const groupEndIndex = seg.startIndex + seg.blocks.length;
				const isActiveGroup = isStreaming && groupEndIndex === blocks.length;
				return (
					<CollapsibleExecutionGroup
						key={`group-${seg.startIndex}-${segIdx}`}
						blocks={seg.blocks as Array<ThinkingContent | ToolCall>}
						toolExecutions={toolExecutions}
						toolResultMap={toolResultMap}
						isStreaming={isActiveGroup}
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
						"whisper-bubble flex flex-col gap-msg-block text-[13px] leading-[var(--prose-line-height)]",
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

interface StreamingBlockViewProps {
	block: LookUiStreamBlock;
	toolExecution?: LookUiToolExecState;
	isStreaming: boolean;
	autoCollapse: boolean;
}

/**
 * Per-block memo component — keyed by stable block.uid.
 * When the parent re-renders with a new blocks array (one per frame after rAF
 * batching), only blocks whose props actually changed will reconcile.
 * Completed/frozen blocks skip entirely.
 */
const StreamingBlockView = memo(function StreamingBlockView({
	block,
	toolExecution,
	isStreaming,
	autoCollapse,
}: StreamingBlockViewProps) {
	if (block.kind === "text") {
		if (!block.text) return null;
		return (
			<div className="message-prose">
				<SkillAwareContent content={block.text} isStreaming={isStreaming && !block.completed} />
			</div>
		);
	}
	if (block.kind === "thinking") {
		return (
			<ThinkingPanel
				thinking={block.thinking}
				isStreaming={isStreaming && !block.completed}
				autoCollapse={autoCollapse}
			/>
		);
	}
	if (block.kind === "toolcall") {
		const s = toolExecution
			? toolExecution.phase === "running"
				? "running"
				: toolExecution.isError
					? "error"
					: "success"
			: /* When exec hasn't arrived yet, default to "running" even
			   if block.completed — toolcall_end may arrive before
			   tool_exec_start. ToolCallCard inline state reset
			   handles the eventual transition correctly. */
				"running";
		// While streaming, prefer the final parsed args; fall back to the
		// accumulated raw JSON (the SDK streams arguments as partial
		// strings before the parsed object arrives). Without this the
		// tool header shows `…` for the entire delta phase.
		const displayArgs = block.args ?? (block.argsRaw ? safelyParsePartialJson(block.argsRaw) : undefined) ?? {};
		return (
			<ToolCallCard
				toolCall={{
					callId: block.toolCallId ?? "",
					toolName: block.toolName ?? "unknown",
					args: displayArgs,
					status: s,
					result: toolExecution?.result ?? toolExecution?.partialResult,
					isError: toolExecution?.isError,
				}}
			/>
		);
	}
	if (block.kind === "image") {
		if (!block.image) return null;
		return <ImageBlock block={block.image} />;
	}
	return null;
});

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

	// Group consecutive thinking/toolcall blocks into CollapsibleExecutionGroup
	// so the badge with rolling counts is shown during streaming, not after;
	// subagent-class calls are carved out into their own card section.
	const segments = segmentExecutionBlocks(
		blocks,
		(b) => b.kind === "thinking" || b.kind === "toolcall",
		(b) => b.kind === "toolcall" && isSubagentTool(b.toolName ?? ""),
	);

	return (
		<div className="flex flex-col gap-msg-block">
			{segments.map((seg, segIdx) => {
				if (seg.kind === "single") {
					const block = seg.block;
					const key = block.uid != null ? `sb-${block.uid}` : `sb-${block.contentIndex ?? block.kind}`;
					return (
						<StreamingBlockView
							key={key}
							block={block}
							toolExecution={
								block.kind === "toolcall" && block.toolCallId ? toolExecutions[block.toolCallId] : undefined
							}
							isStreaming={isStreaming}
							autoCollapse={autoCollapse}
						/>
					);
				}

				if (seg.kind === "subagent") {
					const calls = seg.blocks.map((b) => {
						const toolExecution = b.toolCallId ? toolExecutions[b.toolCallId] : undefined;
						const status = toolExecution
							? toolExecution.phase === "running"
								? ("running" as const)
								: toolExecution.isError
									? ("error" as const)
									: ("success" as const)
							: ("running" as const);
						return {
							callId: b.toolCallId ?? "",
							toolName: b.toolName ?? "unknown",
							args: b.args ?? (b.argsRaw ? safelyParsePartialJson(b.argsRaw) : undefined) ?? {},
							status,
							result: toolExecution?.result ?? toolExecution?.partialResult,
							isError: toolExecution?.isError,
						};
					});
					return <SubagentToolGroup key={`subagents-${seg.startIndex}-${segIdx}`} calls={calls} />;
				}

				// Convert stream blocks to content blocks for CollapsibleExecutionGroup
				const contentBlocks = seg.blocks.map((b) =>
					b.kind === "thinking"
						? { type: "thinking" as const, thinking: b.thinking, thinkingSignature: b.thinkingSignature }
						: ({
								type: "toolCall" as const,
								id: b.toolCallId ?? "",
								name: b.toolName ?? "unknown",
								arguments: b.args ?? {},
							} as ToolCall),
				);

				const groupEndIndex = seg.startIndex + seg.blocks.length;
				const isActiveGroup = isStreaming && groupEndIndex === blocks.length;

				return (
					<CollapsibleExecutionGroup
						key={`group-${seg.startIndex}-0`}
						blocks={contentBlocks}
						toolExecutions={toolExecutions}
						isStreaming={isActiveGroup}
					/>
				);
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
		<div className="flex gap-msg-bubble" style={{ maxWidth: "98%" }}>
			<AiAvatar size="sm" className="mt-msg-avatar shrink-0" />
			<div className="min-w-0 flex-1">
				<MessageHeader
					sender={agentName ?? t("chat.agent")}
					isStreaming={isStreaming}
					isActiveLeaf={false}
					isUser={false}
				/>
				<div className="whisper-bubble whisper-bubble--assistant w-full flex flex-col gap-msg-block text-[13px] leading-[var(--prose-line-height)]">
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
