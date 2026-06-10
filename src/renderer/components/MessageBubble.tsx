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
} from "@shared/types";
import { useAtomValue } from "jotai";
import { MapPin } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { userProfileAtom } from "../store/authAtoms";
import { PixelAgentAvatar } from "./PixelAgentAvatar";
import ExecutionProcess from "./ExecutionProcess";
import SkillAwareContent from "./SkillAwareContent";
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

/** Split blocks into continuous segments. Consecutive thinking/toolCall
 *  blocks are grouped into a "process" segment (rendered inside
 *  ExecutionProcess). Consecutive text blocks are merged into a single
 *  "text" segment to avoid extra DOM wrapping and gap spacing. */
function segmentBlocks(blocks: PiContentBlock[]): Array<{ type: "process" | "text"; blocks: PiContentBlock[] }> {
	const segments: Array<{ type: "process" | "text"; blocks: PiContentBlock[] }> = [];
	for (const block of blocks) {
		const segmentType = block.type === "text" ? "text" : "process";
		const last = segments[segments.length - 1];
		if (last && last.type === segmentType) {
			last.blocks.push(block);
		} else {
			segments.push({ type: segmentType, blocks: [block] });
		}
	}
	return segments;
}

/** Render content blocks grouped into ExecutionProcess for consecutive
 *  thinking/toolCall runs, while text blocks render unwrapped. */
function ContentBlocks({
	blocks,
	isStreaming,
	autoCollapse,
}: {
	blocks: PiContentBlock[];
	isStreaming: boolean;
	autoCollapse: boolean;
}) {
	const segments = segmentBlocks(blocks);

	return (
		<div className="flex flex-col gap-2">
			{segments.map((seg, si) => {
				if (seg.type === "process") {
					return (
						<ExecutionProcess
							key={`ep-${si}`}
							blocks={seg.blocks}
							isStreaming={isStreaming}
							autoCollapse={autoCollapse}
						/>
					);
				}
				return seg.blocks.map((block, bi) => {
					const tb = block as PiTextBlock;
					if (!tb.text) return null;
					return (
						<div key={`text-${si}-${bi}`} className="message-prose">
							<SkillAwareContent content={tb.text} isStreaming={isStreaming} />
						</div>
					);
				});
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
					/* Multi-chunk: flatMap all blocks so segmentBlocks groups across chunk boundaries */
					<div
						className={cn(
							"whisper-bubble whisper-bubble--assistant flex flex-col gap-2 rounded-lg px-3.5 py-2.5 text-[13px] leading-relaxed w-full",
							isActiveLeaf && "border-l-2 border-foreground/40 pl-3",
							flash && "bubble-flash",
						)}
					>
						<ContentBlocks
							blocks={message.assistantChunks.flatMap((c) => c.contentBlocks)}
							isStreaming={message.isStreaming ?? false}
							autoCollapse={autoCollapse}
						/>
					</div>
				) : (
					/* Single-chunk */
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
