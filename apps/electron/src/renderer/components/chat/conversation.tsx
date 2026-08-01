/**
 * Conversation 原语 — 基于 use-stick-to-bottom 的聊天滚动容器
 *
 * 滚动贴底、流式跟随、弹簧缓冲全部由 use-stick-to-bottom 提供
 * （Proma 同款）：resize 弹簧跟随内容增长，用户滚离后自动停止跟随。
 * 本模块只做壳 + 兼容旧上下文接口，让 ChatMessageList /
 * useScrollPositionMemory 零改动接入。
 */

import { cn } from "@look/ui";
import { Button } from "@look/ui/components/ui/button";
import { ArrowDown } from "lucide-react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

// ===== Context（兼容旧接口） =====

interface ConversationContextValue {
	scrollRef: ((el: HTMLElement | null) => void) & { readonly current: HTMLElement | null };
	contentRef: ((el: HTMLElement | null) => void) & { readonly current: HTMLElement | null };
	isAtBottom: boolean;
	/** Re-enable following and move to the latest content. */
	scrollToBottom: () => void;
	/** Keep following only when the user has not intentionally scrolled away. */
	followToBottom: () => void;
	stopScroll: () => void;
}

const ConversationContext = createContext<ConversationContextValue | null>(null);

export function useConversationContext(): ConversationContextValue {
	const ctx = useContext(ConversationContext);
	if (!ctx) {
		throw new Error("useConversationContext must be used within a Conversation component");
	}
	return ctx;
}

// ===== Conversation 根容器 =====

export type ConversationProps = Omit<ComponentProps<typeof StickToBottom>, "children"> & { children?: ReactNode };

export function Conversation({ className, children, ...props }: ConversationProps): ReactElement {
	return (
		<StickToBottom
			className={cn("relative flex-1 overflow-hidden", className)}
			initial="instant"
			resize="smooth"
			role="log"
			aria-live="polite"
			{...props}
		>
			<ConversationContextBridge>{children}</ConversationContextBridge>
		</StickToBottom>
	);
}

/** 把 use-stick-to-bottom 的 context 包装成旧接口，保持消费者零改动。 */
function ConversationContextBridge({ children }: { children: ReactNode }): ReactElement {
	const lib = useStickToBottomContext();

	const value = useMemo<ConversationContextValue>(
		() => ({
			scrollRef: lib.scrollRef,
			contentRef: lib.contentRef,
			isAtBottom: lib.isAtBottom,
			scrollToBottom: () => {
				void lib.scrollToBottom();
			},
			followToBottom: () => {
				// 只在已贴底时跟随，避免把已滚离的用户强行拽回底部。
				void lib.scrollToBottom({ preserveScrollPosition: true });
			},
			stopScroll: lib.stopScroll,
		}),
		[lib],
	);

	return <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>;
}

// ===== ConversationContent 内容区域 =====

export type ConversationContentProps = ComponentProps<"div">;

export function ConversationContent({ className, children, ...props }: ConversationContentProps): ReactElement {
	return (
		<StickToBottom.Content
			scrollClassName="overflow-auto"
			className={cn("flex flex-col gap-msg-row py-msg-list-y", className)}
			aria-live="polite"
			aria-atomic="false"
			{...props}
		>
			{children}
		</StickToBottom.Content>
	);
}

// ===== ConversationScrollButton 回到底部按钮 =====

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export function ConversationScrollButton({ className, ...props }: ConversationScrollButtonProps): ReactElement | null {
	const { t } = useTranslation();
	const { isAtBottom, scrollToBottom } = useStickToBottomContext();

	if (isAtBottom) return null;

	return (
		<Button
			className={cn(
				"absolute bottom-4 right-4 z-10 size-8 rounded-full bg-card p-0 shadow-md transition-colors hover:bg-accent/80",
				className,
			)}
			aria-label={t("chat.scrollToBottom")}
			onClick={() => scrollToBottom()}
			type="button"
			variant="ghost"
			size="icon-xs"
			{...props}
		>
			<ArrowDown className="size-4 text-muted-foreground" />
		</Button>
	);
}

export default Conversation;
