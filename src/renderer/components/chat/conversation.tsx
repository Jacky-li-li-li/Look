/**
 * Conversation 原语 — 基于 use-stick-to-bottom 的聊天滚动容器
 *
 * 替代 react-virtuoso，用原生 DOM 滚动 + ResizeObserver 实现：
 * - 自动滚到底部（initial load + streaming 跟随）
 * - 用户滚离后停止跟随 + 显示"回到底部"按钮
 * - 配合 ScrollPositionManager 实现会话切换位置记忆
 */
import { Button } from "@shared/components/ui/button";
import { cn } from "@shared/lib/utils";
import { ArrowDown } from "lucide-react";
import type { ComponentProps, ReactElement } from "react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

// ===== Conversation 根容器 =====

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export function Conversation({ className, ...props }: ConversationProps): ReactElement {
	return (
		<StickToBottom
			className={cn("relative flex-1 overflow-hidden", className)}
			initial="instant"
			resize="instant"
			role="log"
			{...props}
		/>
	);
}

// ===== ConversationContent 内容区域 =====

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export function ConversationContent({ className, ...props }: ConversationContentProps): ReactElement {
	return (
		<StickToBottom.Content
			className={cn("flex flex-col gap-msg-row py-msg-list-y", className)}
			aria-live="polite"
			aria-atomic="false"
			{...props}
		/>
	);
}

// ===== ConversationScrollButton 回到底部按钮 =====

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export function ConversationScrollButton({ className, ...props }: ConversationScrollButtonProps): ReactElement | null {
	const { t } = useTranslation();
	const { isAtBottom, scrollToBottom } = useStickToBottomContext();

	const handleScrollToBottom = useCallback(() => {
		scrollToBottom();
	}, [scrollToBottom]);

	if (isAtBottom) return null;

	return (
		<Button
			className={cn(
				"absolute bottom-4 right-4 z-10 size-8 rounded-full bg-card p-0 shadow-md hover:bg-accent/80",
				className,
			)}
			aria-label={t("chat.scrollToBottom")}
			onClick={handleScrollToBottom}
			type="button"
			variant="ghost"
			size="icon-xs"
			{...props}
		>
			<ArrowDown className="size-4 text-muted-foreground" />
		</Button>
	);
}
