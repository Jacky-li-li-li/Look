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
import { createContext, useContext, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

/**
 * 流式跟随弹簧参数（比库默认 {damping:0.7, stiffness:0.05, mass:1.25} 快约 11 倍）。
 * 通过 damping/stiffness/mass props 传入，`mergeAnimations` 会将其合并进所有
 * 未显式指定 animation 的滚动调用（RO resize 跟随、scrollToBottom() 等）；
 * 字符串 "smooth" 在 mergeAnimations 中被跳过，故默认 resize="smooth" 实际
 * 使用的就是这套参数，而不是库的 DEFAULT spring。
 *
 * 参数选择依据（离散显式积分弹簧）：速度衰减率 d/m=0.75<1 不会自我放大；
 * 数值验证 5~2000px 全部目标距离单调收敛不过冲（子 Agent 建议的
 * {0.85,0.3,0.5} 因 d/m=1.7 速度放大，大距离会过冲到滚动容器 clamp 上限）。
 */
export const FOLLOW_SPRING = { damping: 0.75, stiffness: 0.25, mass: 1.0 } as const;

// ===== Context（兼容旧接口） =====

interface ConversationContextValue {
	scrollRef: ((el: HTMLElement | null) => void) & { readonly current: HTMLElement | null };
	contentRef: ((el: HTMLElement | null) => void) & { readonly current: HTMLElement | null };
	isAtBottom: boolean;
	/**
	 * 严格贴底判定（库内部 state.isAtBottom，不含 70px 近底容差）。
	 * 为 false 时表示视图未处于贴底锁定（可能差 1~70px 但对外 isAtBottom 为 true），
	 * 回底按钮据此显示，避免"差一点没到底且无按钮可点"。
	 */
	isStrictlyAtBottom: boolean;
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

/**
 * 安全的 Conversation context 访问：不在 Conversation（StickToBottom）内时
 * 返回 null，调用方自行降级（如工具组展开时不脱离底部锁定），不会 throw。
 * 用于嵌套较深、可能在测试/独立渲染中出现的不定上下文消费方。
 */
export function useConversationContextSafe(): ConversationContextValue | null {
	return useContext(ConversationContext);
}

// ===== Conversation 根容器 =====

export type ConversationProps = Omit<ComponentProps<typeof StickToBottom>, "children"> & {
	children?: ReactNode;
	/**
	 * 流式同帧贴底（默认 false）。
	 * use-stick-to-bottom 的 scrollToBottom 会把实际滚动推迟到下一个 rAF
	 * （ResizeObserver → Promise(rAF) → 设 scrollTop），内容增长与滚动补偿
	 * 固定相差一帧：token 流不规律或帧率波动时，视口内的旧内容（状态行、
	 * 最新文本）以「上一帧增长量」的节奏上下蹦跳。
	 * 开启后由本模块的 ResizeObserver 在布局后、绘制前同步把 scrollTop 对齐
	 * 到底，内容增长与滚动零相位差：旧内容绝对静止，新内容从底部生长。
	 */
	syncSticky?: boolean;
};

export function Conversation({ className, children, syncSticky = false, ...props }: ConversationProps): ReactElement {
	return (
		<StickToBottom
			className={cn("relative flex-1 overflow-hidden", className)}
			initial="instant"
			resize="smooth"
			damping={FOLLOW_SPRING.damping}
			stiffness={FOLLOW_SPRING.stiffness}
			mass={FOLLOW_SPRING.mass}
			role="log"
			aria-live="polite"
			{...props}
		>
			<ConversationContextBridge syncSticky={syncSticky}>{children}</ConversationContextBridge>
		</StickToBottom>
	);
}

/**
 * 流式同帧贴底。ResizeObserver 回调运行在 layout 之后、paint 之前：
 * 在回调里同步设置 scrollTop，浏览器会在同一帧重新布局并绘制，滚动与内容
 * 增长零相位差。库自身的 rAF 贴底循环仍会运行，写的是同一目标值（库 target
 * 含 -1 偏移，此处与之一致），幂等。
 * 贴底判定与库的 Proma patch 恢复逻辑一致（严格贴底，或 70px 近底且未主动
 * 滚离），用户滚离后绝不拽回；用户正在容器内选中文本时同样冻结（对齐库
 * scrollToBottom 里的 isSelecting 守卫，避免流式期间选区被拉走）。
 * enabled=false 时不创建 observer（流式开始/结束各重建一次，频率极低）。
 *
 * 继承语义（已知局限）：库的 handleScroll 用 setTimeout(1) + resizeDifference
 * 守卫做 escape 判定，流式期间每帧 resize 会吞掉滚动条拖动/键盘 PageUp 的
 * escape（库自身缺陷，Proma patch 注释亦承认）；本 hook 把贴底同步化后该
 * 缺陷表现得更彻底。滚轮上滚不受影响（handleWheel 同步 escape）。彻底修复
 * 需 patch 库的 escape 判定，超出本模块范围，暂不处理。
 */
function useSyncStickyScroll(lib: ReturnType<typeof useStickToBottomContext>, enabled: boolean): void {
	useEffect(() => {
		if (!enabled) return;
		const scroll = lib.scrollRef.current;
		const content = lib.contentRef.current;
		if (!scroll || !content) return;
		const state = lib.state;

		// 与库 scrollToBottom 的 isSelecting 语义对齐：mousedown 期间有选区且
		// 选区与滚动容器相交 → 冻结贴底，让用户安心选字复制。
		let selecting = false;
		const onMouseDown = () => {
			selecting = true;
		};
		const releaseSelecting = () => {
			selecting = false;
		};
		const isSelecting = (): boolean => {
			if (!selecting) return false;
			const selection = window.getSelection();
			if (!selection || !selection.rangeCount) return false;
			const range = selection.getRangeAt(0);
			return (
				range.commonAncestorContainer.contains(scroll) ||
				(!!scroll && scroll.contains(range.commonAncestorContainer))
			);
		};
		document.addEventListener("mousedown", onMouseDown);
		document.addEventListener("mouseup", releaseSelecting);
		document.addEventListener("click", releaseSelecting);

		const observer = new ResizeObserver(() => {
			if (isSelecting()) return;
			if (!state.isAtBottom && !(state.isNearBottom && !state.escapedFromLock)) return;
			// 与库 targetScrollTop（scrollHeight - 1 - clientHeight）一致，避免与库的
			// overscroll 钳制形成 1px 来回 + 两次 scroll 事件。
			const target = scroll.scrollHeight - scroll.clientHeight - 1;
			if (scroll.scrollTop < target) scroll.scrollTop = target;
		});
		observer.observe(content);
		return () => {
			observer.disconnect();
			document.removeEventListener("mousedown", onMouseDown);
			document.removeEventListener("mouseup", releaseSelecting);
			document.removeEventListener("click", releaseSelecting);
		};
		// scrollRef/contentRef 是稳定 ref callback，state 是库内 useMemo 单例；
		// enabled 翻转（isBusy 开始/结束）时重建 observer。
	}, [enabled, lib.scrollRef, lib.contentRef, lib.state]);
}

/** 把 use-stick-to-bottom 的 context 包装成旧接口，保持消费者零改动。 */
function ConversationContextBridge({
	children,
	syncSticky,
}: {
	children: ReactNode;
	syncSticky: boolean;
}): ReactElement {
	const lib = useStickToBottomContext();
	useSyncStickyScroll(lib, syncSticky);

	const value = useMemo<ConversationContextValue>(
		() => ({
			scrollRef: lib.scrollRef,
			contentRef: lib.contentRef,
			isAtBottom: lib.isAtBottom,
			isStrictlyAtBottom: lib.state.isAtBottom,
			scrollToBottom: () => {
				void lib.scrollToBottom();
			},
			followToBottom: () => {
				// 只在已贴底时跟随，避免把已滚离的用户强行拽回底部。
				// wait:true → 不打断已有动画链（behavior 相同时复用 promise），
				// 避免流式期间每次调用都把弹簧速度清零重新加速。
				void lib.scrollToBottom({ preserveScrollPosition: true, wait: true });
			},
			stopScroll: lib.stopScroll,
		}),
		// 只依赖稳定成员：scrollRef/contentRef/scrollToBottom/stopScroll 均为
		// 稳定引用（库内 useCallback/useRefCallback 固定 deps），isAtBottom 只在
		// 贴底状态翻转时变化。state 为 useMemo 单例（稳定引用），其字段变化
		// （如内部 isAtBottom）通过 lib.isAtBottom 的翻转驱动消费方重渲染，
		// 读 lib.state.isAtBottom 时始终是最新值。不依赖 lib 整体对象，避免
		// escapedFromLock 等内部状态翻转（用户滚动穿过 70px 边界时高频发生）
		// 触发全体消费方（CEG / SubagentToolGroup / ThinkingPanel）无谓重渲染。
		[lib.scrollRef, lib.contentRef, lib.isAtBottom, lib.state, lib.scrollToBottom, lib.stopScroll],
	);

	return <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>;
}

// ===== ConversationContent 内容区域 =====

export type ConversationContentProps = ComponentProps<"div">;

export function ConversationContent({ className, children, ...props }: ConversationContentProps): ReactElement {
	return (
		<StickToBottom.Content
			scrollClassName="overflow-auto look-message-scrollbar"
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
	const { isStrictlyAtBottom, scrollToBottom } = useConversationContext();

	if (isStrictlyAtBottom) return null;

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
