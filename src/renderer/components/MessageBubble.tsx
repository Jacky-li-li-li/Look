// ============================================================
// MessageBubble — Whisper Bubbles + Inset Drawers (Ink Wash)
//
// v0.4: Branching actions (Branch from here / Fork to new chat)
// are rendered by ChatPanel *outside* the bubble, in a sibling
// row directly below the message row. The whole row is a
// `group/message` so hovering the bubble OR the actions keeps
// the strip visible. This matches the ChatGPT pattern and keeps
// the bubble itself free of any meta-UI.
//
// User bubbles do NOT get an action strip — forking off a user
// message is a different mental model ("re-ask the same question")
// and we don't want to suggest it accidentally. The future
// /tree command palette (Phase 1.5+) will let the user navigate
// to any user message as a fork point if they really want to.
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
import { useAtomValue } from "jotai";
import { MapPin } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { userProfileAtom } from "../store/authAtoms";
import { PixelAgentAvatar } from "./PixelAgentAvatar";
import SkillAwareContent from "./SkillAwareContent";
import ThinkingPanel from "./ThinkingPanel";
import ToolCallCard from "./ToolCallCard";
import UserAvatar from "./UserAvatar";

interface MessageBubbleProps {
	message: PiMessage;
	agentRole?: AgentRole;
	agentName?: string;
	autoCollapse: boolean;
	/**
	 * v0.4: whether this message's id matches the session's
	 * current leafId. Renders a subtle "active" accent (left
	 * border + pin badge) so the user can see at a glance which
	 * branch they're on. */
	isActiveLeaf?: boolean;
	/**
	 * v0.4: when true, applies the .bubble-flash animation to
	 * the inner whisper-bubble. ChatPanel sets this on the
	 * entry it just navigated to, for ~900ms, then clears it.
	 * The animation is a 2px ink-color ring growing then
	 * fading — see App.css.
	 */
	flash?: boolean;
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

const MessageBubble = memo(function MessageBubble({
	message,
	agentRole,
	agentName,
	autoCollapse,
	isActiveLeaf = false,
	flash = false,
}: MessageBubbleProps) {
	const { t } = useTranslation();
	const userProfile = useAtomValue(userProfileAtom);
	const isUser = message.role === "user";
	const isAssistant = message.role === "assistant";

	return (
		<div
			className={cn("flex gap-3", isUser && "flex-row-reverse self-end")}
			style={{ maxWidth: isUser ? "80%" : "92%" }}
		>
			{/* Avatar */}
			{!isUser ? (
				<PixelAgentAvatar role={agentRole} size="sm" className="mt-0.5 shrink-0" />
			) : (
				<UserAvatar avatar={userProfile.avatar} size="sm" className="mt-0.5" />
			)}

			<div className="min-w-0 flex-1">
				{/* Sender label */}
				<div
					className={cn("mb-1 flex items-center gap-2 text-[10px] text-muted-foreground", isUser && "justify-end")}
				>
					<span className="font-medium uppercase tracking-wider">
						{isUser ? userProfile.userName || t("chat.you") : (agentName ?? t("chat.agent"))}
					</span>
					{message.isStreaming && <span className="status-mark" data-status="thinking" />}
					{isAssistant && isActiveLeaf && (
						<span
							title={t("chat.activeLeaf")}
							className="inline-flex items-center gap-0.5 rounded-sm border border-hairline px-1 py-px text-[9px] font-medium uppercase tracking-wider text-muted-foreground/80"
						>
							<MapPin className="size-2.5" />
							{t("chat.activeLeaf")}
						</span>
					)}
				</div>

				{/* Whisper bubble */}
				{message.assistantChunks && message.assistantChunks.length > 0 ? (
					/* ── Multi-chunk: separate blocks under ONE label ── */
					<div
						className={cn(
							"whisper-bubble whisper-bubble--assistant flex flex-col gap-3 rounded-lg px-3.5 py-2.5 text-[13px] leading-relaxed w-full",
							isActiveLeaf && "border-l-2 border-foreground/40 pl-3",
							flash && "bubble-flash",
						)}
					>
						{message.assistantChunks.map((chunk, ci) => (
							<div key={ci} className="flex flex-col gap-2">
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
							isAssistant && isActiveLeaf && "border-l-2 border-foreground/40 pl-3",
							flash && "bubble-flash",
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
