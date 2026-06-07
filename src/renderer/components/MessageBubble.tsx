// ============================================================
// MessageBubble — Whisper Bubbles + Inset Drawers (Ink Wash)
// ============================================================

import { cn } from "@shared/lib/utils";
import type {
	AgentRole,
	PiContentBlock,
	PiMessage,
	PiTextBlock,
	PiThinkingBlock,
	PiToolCallBlock,
} from "@shared/types";
import { UserRound } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { PixelAgentAvatar } from "./PixelAgentAvatar";
import SkillAwareContent from "./SkillAwareContent";
import ThinkingPanel from "./ThinkingPanel";
import ToolCallCard from "./ToolCallCard";

interface MessageBubbleProps {
	message: PiMessage;
	agentRole?: AgentRole;
	agentName?: string;
	autoCollapse: boolean;
}

/** Render content blocks in pi SDK order (thinking → toolCall → text).
 *  No ExecutionProcess wrapping — each block type is independently rendered. */
function ContentBlocks({
	blocks,
	isStreaming,
	autoCollapse,
}: {
	blocks: PiContentBlock[];
	isStreaming: boolean;
	autoCollapse: boolean;
}) {
	return (
		<div className="flex flex-col gap-2">
			{blocks.map((block, i) => {
				if (block.type === "thinking") {
					const tb = block as PiThinkingBlock;
					if (!tb.thinking) return null;
					return (
						<ThinkingPanel
							key={`t-${i}`}
							thinking={tb.thinking}
							isStreaming={isStreaming}
							autoCollapse={autoCollapse}
						/>
					);
				}
				if (block.type === "toolCall") {
					const tc = block as PiToolCallBlock;
					return (
						<ToolCallCard
							key={tc.id || `tc-${i}`}
							toolCall={{
								callId: tc.id,
								toolName: tc.name,
								args: tc.arguments,
								status: tc.status,
								result: tc.result,
								isError: tc.isError,
							}}
						/>
					);
				}
				if (block.type === "text") {
					const tb = block as PiTextBlock;
					if (!tb.text) return null;
					return (
						<div key={`text-${i}`} className="message-prose">
							<SkillAwareContent content={tb.text} isStreaming={isStreaming} />
						</div>
					);
				}
				return null;
			})}
		</div>
	);
}

const MessageBubble = memo(function MessageBubble({ message, agentRole, agentName, autoCollapse }: MessageBubbleProps) {
	const { t } = useTranslation();
	const isUser = message.role === "user";

	return (
		<div
			className={cn("flex gap-3", isUser && "flex-row-reverse self-end")}
			style={{ maxWidth: isUser ? "80%" : "92%" }}
		>
			{/* Avatar */}
			{!isUser ? (
				<PixelAgentAvatar role={agentRole} size="sm" className="mt-0.5 shrink-0" />
			) : (
				<div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-hairline bg-background text-foreground">
					<UserRound className="size-3.5" />
				</div>
			)}

			<div className="min-w-0 flex-1">
				{/* Sender label */}
				<div
					className={cn("mb-1 flex items-center gap-2 text-[10px] text-muted-foreground", isUser && "justify-end")}
				>
					<span className="font-medium uppercase tracking-wider">
						{isUser ? t("chat.you") : (agentName ?? t("chat.agent"))}
					</span>
					{message.isStreaming && <span className="status-mark" data-status="thinking" />}
				</div>

				{/* Whisper bubble */}
				{message.assistantChunks && message.assistantChunks.length > 0 ? (
					/* ── Multi-chunk: separate blocks under ONE label ── */
					<div className="flex flex-col gap-3">
						{message.assistantChunks.map((chunk, ci) => (
							<div
								key={ci}
								className={cn(
									"whisper-bubble whisper-bubble--assistant flex flex-col gap-2 rounded-lg px-3.5 py-2.5 text-[13px] leading-relaxed w-full",
									// Last chunk gets a subtle left-accent to indicate it's the final answer
									ci === message.assistantChunks!.length - 1 &&
										message.assistantChunks!.length > 1 &&
										"border-l-2 border-primary/30",
								)}
							>
								<ContentBlocks
									blocks={chunk.contentBlocks}
									isStreaming={!!message.isStreaming && ci === message.assistantChunks!.length - 1}
									autoCollapse={autoCollapse}
								/>
							</div>
						))}
					</div>
				) : (
					/* ── Single-chunk ── */
					<div
						className={cn(
							"whisper-bubble flex flex-col gap-2 rounded-lg px-3.5 py-2.5 text-[13px] leading-relaxed",
							isUser && "whisper-bubble--user",
							!isUser && "whisper-bubble--assistant w-full",
						)}
					>
						<ContentBlocks
							blocks={message.contentBlocks}
							isStreaming={message.isStreaming ?? false}
							autoCollapse={autoCollapse}
						/>
					</div>
				)}
			</div>
		</div>
	);
});

export default MessageBubble;
