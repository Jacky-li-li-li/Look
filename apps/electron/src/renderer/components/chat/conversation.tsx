/**
 * Conversation 原语 — 基于原生实现的聊天滚动容器
 *
 * 用 React Context + ResizeObserver + scroll 事件实现：
 * - 自动滚到底部（initial load + streaming 跟随）
 * - 用户滚离后停止跟随 + 显示"回到底部"按钮
 * - 配合 ScrollPositionManager 实现会话切换位置记忆
 */
import { Button } from "@look/ui/components/ui/button";
import { cn } from "@look/ui";
import { ArrowDown } from "lucide-react";
import type { ComponentProps, ReactElement } from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

// ===== Context =====

interface ConversationContextValue {
	scrollRef: ((el: HTMLDivElement | null) => void) & { readonly current: HTMLDivElement | null };
	contentRef: ((el: HTMLDivElement | null) => void) & { readonly current: HTMLDivElement | null };
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

// ===== useChatScroll hook =====

const BOTTOM_PROXIMITY_PX = 24;
const STOP_FOLLOW_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return target.isContentEditable || Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function useChatScroll(): ConversationContextValue {
	const scrollElRef = useRef<HTMLDivElement | null>(null);
	const contentElRef = useRef<HTMLDivElement | null>(null);
	const [isAtBottom, setIsAtBottom] = useState(true);
	const shouldFollowRef = useRef(true);
	const pointerDownRef = useRef(false);
	const followFrameRef = useRef<number | null>(null);

	const updateAtBottom = useCallback((next: boolean) => {
		setIsAtBottom((current) => (current === next ? current : next));
	}, []);

	const followToBottom = useCallback(() => {
		if (!shouldFollowRef.current || followFrameRef.current !== null) return;

		followFrameRef.current = requestAnimationFrame(() => {
			followFrameRef.current = null;
			if (!shouldFollowRef.current) return;

			const scrollEl = scrollElRef.current;
			if (!scrollEl) return;
			scrollEl.scrollTop = scrollEl.scrollHeight;
			updateAtBottom(true);
		});
	}, [updateAtBottom]);

	// ResizeObserver — 内容高度增长时自动滚到底部
	useEffect(() => {
		const content = contentElRef.current;
		if (!content) return;

		const observer = new ResizeObserver(followToBottom);
		observer.observe(content);
		return () => observer.disconnect();
	}, [followToBottom]);

	// 几何位置只负责 UI 状态。自动跟随意图由用户输入单独控制，
	// 避免流式 Markdown 重排产生的瞬时距离误判永久关闭跟随。
	useEffect(() => {
		const el = scrollElRef.current;
		if (!el) return;

		const onScroll = () => {
			const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
			const atBottom = distance <= BOTTOM_PROXIMITY_PX;
			updateAtBottom(atBottom);

			if (atBottom) {
				shouldFollowRef.current = true;
			} else if (pointerDownRef.current) {
				shouldFollowRef.current = false;
			}
		};
		const onWheel = (event: WheelEvent) => {
			if (event.deltaY < 0) shouldFollowRef.current = false;
		};
		const onPointerDown = () => {
			pointerDownRef.current = true;
		};
		const onPointerUp = () => {
			pointerDownRef.current = false;
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (!isEditableTarget(event.target) && STOP_FOLLOW_KEYS.has(event.key)) {
				shouldFollowRef.current = false;
			}
		};

		el.addEventListener("scroll", onScroll, { passive: true });
		el.addEventListener("wheel", onWheel, { passive: true });
		el.addEventListener("pointerdown", onPointerDown, { passive: true });
		window.addEventListener("pointerup", onPointerUp, { passive: true });
		window.addEventListener("pointercancel", onPointerUp, { passive: true });
		window.addEventListener("keydown", onKeyDown);
		return () => {
			el.removeEventListener("scroll", onScroll);
			el.removeEventListener("wheel", onWheel);
			el.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onPointerUp);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [updateAtBottom]);

	// 初始滚到底部
	useEffect(() => {
		followToBottom();
	}, [followToBottom]);

	useEffect(
		() => () => {
			if (followFrameRef.current !== null) {
				cancelAnimationFrame(followFrameRef.current);
				followFrameRef.current = null;
			}
		},
		[],
	);

	const scrollToBottom = useCallback(() => {
		shouldFollowRef.current = true;
		const scrollEl = scrollElRef.current;
		if (scrollEl) {
			scrollEl.scrollTop = scrollEl.scrollHeight;
			updateAtBottom(true);
		}
		followToBottom();
	}, [followToBottom, updateAtBottom]);

	const stopScroll = useCallback(() => {
		shouldFollowRef.current = false;
		updateAtBottom(false);
	}, [updateAtBottom]);

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

	return { scrollRef, contentRef, isAtBottom, scrollToBottom, followToBottom, stopScroll };
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
		<div ref={scrollRef} className="h-full w-full overflow-auto" style={{ scrollbarGutter: "stable both-edges" }}>
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
