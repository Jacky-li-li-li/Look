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
import type { SessionEntry } from "@shared/types";
import { useAtomValue } from "jotai";
import { MapPin } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { userProfileAtom } from "../store/authAtoms";
import type { RendererToolExecutionState } from "../store/sessionTypes";
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
	toolExecutions: Record<string, RendererToolExecutionState>;
	toolResultMap?: Record<string, ToolResultMessage>;
	turnDurationMs?: number | null;
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
			className="max-h-96 max-w-full rounded-md border border-hairline object-contain"
		/>
	);
}

function MessageHeader({
	sender,
	timestamp,
	isStreaming,
	isActiveLeaf,
	isUser,
}: {
	sender: string;
	timestamp: number;
	isStreaming: boolean;
	isActiveLeaf: boolean;
	isUser: boolean;
}) {
	const { t } = useTranslation();
	return (
		<div className={cn("mb-0.5 flex items-center gap-2 text-[10px] text-muted-foreground", isUser && "justify-end")}>
			<span className="font-medium uppercase tracking-wider">{sender}</span>
			<span className="tabular-nums" title={new Date(timestamp).toLocaleString()}>
				{formatMessageTime(timestamp)}
			</span>
			{isStreaming && <span className="status-mark" data-status="thinking" />}
			{isActiveLeaf && (
				<span className="inline-flex items-center gap-0.5 rounded-sm border border-hairline px-1 py-px text-[9px] font-medium uppercase tracking-wider text-muted-foreground/80">
					<MapPin className="size-2.5" />
					{t("chat.activeLeaf")}
				</span>
			)}
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
	toolExecutions: Record<string, RendererToolExecutionState>;
	toolResultMap?: Record<string, ToolResultMessage>;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			{blocks.map((block, index) => {
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
					? resultText(execution.result ?? execution.partialResult)
					: resultText(persistedResult?.content);

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
	turnDurationMs,
	isActiveLeaf = false,
	flash = false,
}: MessageBubbleProps) {
	const { t } = useTranslation();
	const userProfile = useAtomValue(userProfileAtom);
	const isUser = message.role === "user";
	const assistant = message.role === "assistant" ? (message as AssistantMessage) : null;
	const timestamp = "timestamp" in message ? message.timestamp : Date.now();
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
				<MessageHeader
					sender={sender}
					timestamp={timestamp}
					isStreaming={isStreaming}
					isActiveLeaf={isActiveLeaf}
					isUser={isUser}
				/>
				<div
					className={cn(
						"whisper-bubble flex flex-col gap-1.5 text-[13px] leading-relaxed",
						isUser ? "whisper-bubble--user" : "whisper-bubble--assistant w-full",
						assistant && isActiveLeaf && "border-l-2 border-foreground/40 pl-3",
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
					{assistant && (
						<div className="flex flex-wrap gap-x-2 text-[9px] text-muted-foreground/60">
							<span>{assistant.model}</span>
							{turnDurationMs != null && turnDurationMs > 0 && (
								<span>
									{" · "}
									{turnDurationMs >= 60_000
										? `${(turnDurationMs / 60_000).toFixed(1)}m`
										: `${(turnDurationMs / 1_000).toFixed(1)}s`}
								</span>
							)}
							{assistant.responseModel && assistant.responseModel !== assistant.model && (
								<span>→ {assistant.responseModel}</span>
							)}
							{assistant.diagnostics && assistant.diagnostics.length > 0 && (
								<details className="basis-full">
									<summary className="cursor-pointer">diagnostics ({assistant.diagnostics.length})</summary>
									<pre className="mt-1 overflow-x-auto whitespace-pre-wrap">
										{JSON.stringify(assistant.diagnostics, null, 2)}
									</pre>
								</details>
							)}
						</div>
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

function formatMessageTime(ts: number): string {
	const diff = Date.now() - ts;
	const seconds = Math.floor(diff / 1000);
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	return new Date(ts).toLocaleDateString();
}

export default MessageBubble;
