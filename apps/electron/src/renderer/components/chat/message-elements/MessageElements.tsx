// ============================================================
// message-elements — 消息渲染原语层（对标 Proma ai-elements）
//
// 无业务逻辑、可组合的视觉原语。组装只发生在 MessageItem。
// ============================================================

import { cn } from "@look/ui";
import { UserAvatar } from "@look/ui/components/UserAvatar";
import type { ReactNode } from "react";
import { AiAvatar } from "../../AiAvatar";

// ===== MessageRoot — 消息根容器 =====

interface MessageRootProps {
	from: "user" | "assistant";
	children: ReactNode;
	className?: string;
}

/** 消息根容器：user 右对齐 + 气泡限宽（user 90% / assistant 98%）。 */
export function MessageRoot({ from, children, className }: MessageRootProps): ReactNode {
	return (
		<div
			className={cn("flex gap-msg-bubble", from === "user" && "flex-row-reverse self-end", className)}
			style={{ maxWidth: from === "user" ? "90%" : "98%" }}
		>
			{children}
		</div>
	);
}

// ===== MessageAvatar — 头像 =====

interface MessageAvatarProps {
	from: "user" | "assistant";
	userAvatar?: string;
	className?: string;
}

/** 消息头像（user 显示用户头像，assistant 显示 AI 头像）。 */
export function MessageAvatar({ from, userAvatar = "", className }: MessageAvatarProps): ReactNode {
	if (from === "user") {
		return <UserAvatar avatar={userAvatar} size="sm" className="mt-msg-avatar" />;
	}
	return <AiAvatar size="sm" className={cn("mt-msg-avatar shrink-0", className)} />;
}

// ===== MessageHeader — 消息头部 =====

interface MessageHeaderProps {
	sender: string;
	isStreaming: boolean;
	isActiveLeaf: boolean;
	isUser: boolean;
}

/** 消息头部：发送者名称 + streaming 标记。
 *  isActiveLeaf 保留为参数以匹配原签名（当前不使用）。 */
export function MessageHeader({ sender, isStreaming, isActiveLeaf, isUser }: MessageHeaderProps): ReactNode {
	void isActiveLeaf;
	return (
		<div
			className={cn(
				// h-[30px] = 头像总高（mt-msg-avatar 2px + size-sm 28px）：名称行占满头像高度，
				// 名称垂直居中，正文第一行从头像底部水平线开始。
				"mb-msg-header flex h-[30px] items-center gap-2 text-[10px] text-muted-foreground",
				isUser && "justify-end",
			)}
		>
			<span className="font-medium uppercase tracking-wider">{sender}</span>
			{isStreaming && <span className="status-mark" data-status="thinking" />}
		</div>
	);
}

// ===== MessageContent — 气泡内容容器 =====

interface MessageContentProps {
	isUser: boolean;
	flash?: boolean;
	children: ReactNode;
	className?: string;
}

/** 气泡内容容器（whisper-bubble）。 */
export function MessageContent({ isUser, flash, children, className }: MessageContentProps): ReactNode {
	return (
		<div
			className={cn(
				"whisper-bubble flex flex-col gap-msg-block text-[var(--prose-font-size)] leading-[var(--prose-line-height)]",
				isUser ? "whisper-bubble--user" : "whisper-bubble--assistant w-full",
				flash && "bubble-flash",
				className,
			)}
		>
			{children}
		</div>
	);
}
