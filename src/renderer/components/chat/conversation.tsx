/**
 * Conversation 原语 — 基于原生实现的聊天滚动容器
 *
 * 用 React Context + ResizeObserver + scroll 事件实现：
 * - 自动滚到底部（initial load + streaming 跟随）
 * - 用户滚离后停止跟随 + 显示"回到底部"按钮
 * - 配合 ScrollPositionManager 实现会话切换位置记忆
 */
import { Button } from "@shared/components/ui/button";
import { cn } from "@shared/lib/utils";
import { ArrowDown } from "lucide-react";
import type { ComponentProps, ReactElement } from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

// ===== Context =====

interface ConversationContextValue {
	scrollRef: ((el: HTMLDivElement | null) => void) & { readonly current: HTMLDivElement | null };
	contentRef: ((el: HTMLDivElement | null) => void) & { readonly current: HTMLDivElement | null };
	isAtBottom: boolean;
	scrollToBottom: () => void;
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

// ===== useChatScroll hook =====

function useChatScroll(): ConversationContextValue {
	const scrollElRef = useRef<HTMLDivElement | null>(null);
	const contentElRef = useRef<HTMLDivElement | null>(null);
	const [isAtBottom, setIsAtBottom] = useState(true);
	const isAtBottomRef = useRef(true);

	useEffect(() => {
		isAtBottomRef.current = isAtBottom;
	}, [isAtBottom]);

	// ResizeObserver — 内容高度增长时自动滚到底部
	useEffect(() => {
		const content = contentElRef.current;
		if (!content) return;

		const observer = new ResizeObserver(() => {
			if (isAtBottomRef.current && scrollElRef.current) {
				scrollElRef.current.scrollTop = scrollElRef.current.scrollHeight;
			}
		});
		observer.observe(content);
		return () => observer.disconnect();
	}, []);

	// scroll 事件 — 判断用户是否滚离底部（阈值 2px）
	useEffect(() => {
		const el = scrollElRef.current;
		if (!el) return;

		const onScroll = () => {
			const s = scrollElRef.current;
			if (!s) return;
			const dist = s.scrollHeight - s.scrollTop - s.clientHeight;
			const atBottom = dist <= 2;
			if (atBottom !== isAtBottomRef.current) {
				isAtBottomRef.current = atBottom;
				setIsAtBottom(atBottom);
			}
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, []);

	// 初始滚到底部
	useEffect(() => {
		if (scrollElRef.current) {
			scrollElRef.current.scrollTop = scrollElRef.current.scrollHeight;
		}
	}, []);

	const scrollToBottom = useCallback(() => {
		if (scrollElRef.current) {
			scrollElRef.current.scrollTop = scrollElRef.current.scrollHeight;
			setIsAtBottom(true);
		}
	}, []);

	const stopScroll = useCallback(() => setIsAtBottom(false), []);

	const scrollRefCallback = useCallback((el: HTMLDivElement | null) => {
		scrollElRef.current = el;
	}, []);

	const contentRefCallback = useCallback((el: HTMLDivElement | null) => {
		contentElRef.current = el;
	}, []);

	const scrollRef = Object.assign(scrollRefCallback, {
		get current() {
			return scrollElRef.current;
		},
	});

	const contentRef = Object.assign(contentRefCallback, {
		get current() {
			return contentElRef.current;
		},
	});

	return { scrollRef, contentRef, isAtBottom, scrollToBottom, stopScroll };
}

// ===== Conversation 根容器 =====

export type ConversationProps = ComponentProps<"div">;

export function Conversation({ className, ...props }: ConversationProps): ReactElement {
	const ctx = useChatScroll();

	return (
		<ConversationContext.Provider value={ctx}>
			<div className={cn("relative flex-1 overflow-hidden", className)} role="log" {...props} />
		</ConversationContext.Provider>
	);
}

// ===== ConversationContent 内容区域 =====

export type ConversationContentProps = ComponentProps<"div">;

export function ConversationContent({ className, ...props }: ConversationContentProps): ReactElement {
	const { scrollRef, contentRef } = useConversationContext();

	return (
		<div
			ref={scrollRef}
			className="h-full w-full overflow-auto"
			style={{ scrollbarGutter: "stable both-edges" }}
		>
			<div
				ref={contentRef}
				className={cn("flex flex-col gap-msg-row py-msg-list-y", className)}
				aria-live="polite"
				aria-atomic="false"
				{...props}
			/>
		</div>
	);
}

// ===== ConversationScrollButton 回到底部按钮 =====

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export function ConversationScrollButton({ className, ...props }: ConversationScrollButtonProps): ReactElement | null {
	const { t } = useTranslation();
	const { isAtBottom, scrollToBottom } = useConversationContext();

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
