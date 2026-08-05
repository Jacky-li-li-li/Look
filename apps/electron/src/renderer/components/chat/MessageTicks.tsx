// ============================================================
// MessageTicks — 消息区右侧垂直刻度
//
// 每条 user 消息对应一个刻度。刻度集中在消息区右侧的一个
// 紧凑竖条内（整体垂直居中、贴右缘），刻度均匀等距排列，
// 不反映消息在对话中的位置：
//   - 悬停刻度 → 左侧小窗展示该 user 消息的文本预览
//   - 点击刻度 → 调用 onNavigate（由 ChatMessagesInner 负责
//     stopScroll + 平滑滚动到该消息 + 闪烁高亮）
//   - 滚动时视口内所有可见的 user 消息刻度高亮为深色
//
// 高亮取舍：按“消息矩形与视口有交集”判定（部分可见也算可见）。
// 刻度条最多 280px，消息超过 ~23 条后间距被压缩为等密；
// 极端长会话（>90 条）刻度可能视觉重叠（集中式设计的固有
// 限制）。
//
// 必须放在 Conversation（StickToBottom）内部使用，通过
// useConversationContext 读取 scrollRef：仅在内容可滚动时显示
// （内容全部可见时刻度无意义）。
// ============================================================

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { cn } from "@look/ui";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConversationContext } from "./conversation";

export interface MessageTicksItem {
	/** timeline item id（点击跳转时传给 onNavigate） */
	id: string;
	/** user 消息文本预览；纯图片消息为空串 */
	preview: string;
}

interface MessageTicksProps {
	items: MessageTicksItem[];
	/** 点击刻度后的跳转回调（滚动 + 闪烁由 ChatMessagesInner 负责） */
	onNavigate?: (entryId: string) => void;
}

/** 鼠标离开刻度/小窗后多久关闭小窗（给鼠标留出滑入小窗的桥接时间） */
const CLOSE_DELAY_MS = 120;
/** 刻度间距（px）：消息少时按此间距排布 */
const TICK_SPACING_PX = 10;
/** 刻度条最小高度（px）：消息很少时仍保持紧凑（避免 2 条消息时刻度被拉开） */
const MIN_BAR_HEIGHT = 32;
/** 刻度条最大高度（px）：消息很多时封顶，保持“集中”形态 */
const MAX_BAR_HEIGHT = 280;

/** 提取 user 消息的文本预览：string 直接取，blocks 取 text block 拼接 */
export function userMessagePreview(message: AgentMessage): string {
	if (message.role !== "user") return "";
	const content = message.content;
	if (typeof content === "string") return content.trim();
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

export const MessageTicks = memo(function MessageTicks({ items, onNavigate }: MessageTicksProps) {
	const { t } = useTranslation();
	const { scrollRef, contentRef } = useConversationContext();

	const [canScroll, setCanScroll] = useState(false);
	const [currentIds, setCurrentIds] = useState<ReadonlySet<string>>(new Set());
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const [popupTop, setPopupTop] = useState(0);

	const popupRef = useRef<HTMLDivElement>(null);
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// 刻度条高度：自适应，消息多时封顶
	const barHeight = useMemo(() => {
		if (items.length === 0) return 0;
		return Math.min(MAX_BAR_HEIGHT, Math.max(MIN_BAR_HEIGHT, items.length * TICK_SPACING_PX));
	}, [items.length]);

	const clearCloseTimer = useCallback(() => {
		if (closeTimerRef.current) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	}, []);

	// 卸载时清理关闭定时器
	useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

	// 刻度条隐藏（无消息 / 不可滚动）时清残留悬停态，防止内容从
	// 可滚→不可滚→可滚翻转后无悬停却残留小窗
	useEffect(() => {
		if (items.length === 0 || !canScroll) setHoveredId(null);
	}, [items, canScroll]);

	// ── 当前消息跟踪 ──
	// 视口内所有可见的 user 消息刻度都高亮为深色（消息矩形与视口
	// 有交集即算可见），滚动时动态更新。数据来自 DOM 位置
	// （data-message-id 节点）。
	const updateCurrent = useCallback(() => {
		const el = scrollRef.current;
		const next = new Set<string>();
		if (el && items.length > 0) {
			const containerRect = el.getBoundingClientRect();
			const viewportTop = el.scrollTop;
			const viewportBottom = viewportTop + el.clientHeight;
			const wanted = new Set(items.map((item) => item.id));
			for (const node of el.querySelectorAll<HTMLElement>("[data-message-id]")) {
				const id = node.getAttribute("data-message-id");
				if (!id || !wanted.has(id)) continue;
				const r = node.getBoundingClientRect();
				const top = r.top - containerRect.top + el.scrollTop;
				const bottom = top + r.height;
				if (bottom > viewportTop && top < viewportBottom) next.add(id);
			}
		}
		// 集合内容不变时不触发重渲染（React 对 Set 恒为新引用，需手动比较）
		setCurrentIds((prev) => {
			if (prev.size === next.size && [...prev].every((id) => next.has(id))) return prev;
			return next;
		});
	}, [scrollRef, items]);

	// 用 ref 持有最新 handler：measurement effect 只依赖 scrollRef/contentRef，
	// 流式时 items 变化不会导致监听器反复重建（RO disconnect/observe 等）。
	const updateCurrentRef = useRef(updateCurrent);
	useEffect(() => {
		updateCurrentRef.current = updateCurrent;
	}, [updateCurrent]);

	// ── 可滚动性检测 ──
	// 内容不可滚动（全部消息可见）时隐藏刻度条。内容增长（流式）、
	// 容器尺寸变化、窗口 resize 都会触发重算；items 变化通过
	// contentRef 的 ResizeObserver（内容高度变化）间接触发。
	useEffect(() => {
		const scrollEl = scrollRef.current;
		if (!scrollEl) return;

		const measure = (): void => {
			const el = scrollRef.current;
			if (!el) return;
			const { scrollHeight, clientHeight } = el;
			setCanScroll(scrollHeight > clientHeight + 10);
		};

		measure();
		updateCurrentRef.current();
		const ro = new ResizeObserver(() => {
			measure();
			updateCurrentRef.current();
		});
		ro.observe(scrollEl);
		const contentEl = contentRef.current;
		if (contentEl) ro.observe(contentEl);
		// scroll 用 rAF 节流：同一帧多次 scroll 只算一次，避免每次滚动都触发
		// querySelectorAll + getBoundingClientRect 的强制布局（layout thrash）
		let rafId: number | null = null;
		const onScroll = (): void => {
			if (rafId != null) return;
			rafId = requestAnimationFrame(() => {
				rafId = null;
				updateCurrentRef.current();
			});
		};
		scrollEl.addEventListener("scroll", onScroll, { passive: true });
		const onWindowResize = (): void => {
			measure();
			updateCurrentRef.current();
		};
		window.addEventListener("resize", onWindowResize);
		return () => {
			if (rafId != null) cancelAnimationFrame(rafId);
			ro.disconnect();
			scrollEl.removeEventListener("scroll", onScroll);
			window.removeEventListener("resize", onWindowResize);
		};
	}, [scrollRef, contentRef]);

	// ── 小窗垂直定位：与刻度居中对齐，并限制在刻度条内 ──
	useLayoutEffect(() => {
		if (!hoveredId) return;
		const index = items.findIndex((it) => it.id === hoveredId);
		if (index < 0) return;
		const popupHeight = popupRef.current?.offsetHeight ?? 0;
		const tickTopPx = ((index + 0.5) / items.length) * barHeight;
		const top = Math.max(4, Math.min(tickTopPx - popupHeight / 2, barHeight - popupHeight - 4));
		setPopupTop(top);
	}, [hoveredId, items, barHeight]);

	const handleEnter = useCallback(
		(id: string) => {
			clearCloseTimer();
			setHoveredId(id);
		},
		[clearCloseTimer],
	);

	const handleLeave = useCallback(() => {
		clearCloseTimer();
		closeTimerRef.current = setTimeout(() => setHoveredId(null), CLOSE_DELAY_MS);
	}, [clearCloseTimer]);

	const handleClick = useCallback(
		(id: string) => {
			clearCloseTimer();
			setHoveredId(null);
			onNavigate?.(id);
		},
		[clearCloseTimer, onNavigate],
	);

	if (items.length === 0 || !canScroll) return null;

	const hoveredIndex = items.findIndex((it) => it.id === hoveredId);
	const hoveredItem = hoveredIndex >= 0 ? items[hoveredIndex] : null;

	return (
		<div
			className="message-ticks pointer-events-none absolute top-1/2 right-0 z-10 -translate-y-1/2"
			role="group"
			aria-label={t("chat.userTicks")}
		>
			<div className="message-ticks-bar relative" style={{ height: barHeight, width: 28 }}>
				{items.map((item, i) => (
					<button
						key={item.id}
						type="button"
						data-tick-id={item.id}
						className={cn(
							"pointer-events-auto absolute right-1 h-[3px] w-4 cursor-pointer rounded-full transition-colors hover:scale-y-150 hover:bg-foreground",
							currentIds.has(item.id) ? "bg-foreground" : "bg-foreground/25",
						)}
						style={{ top: `calc(${((i + 0.5) / items.length) * 100}% - 1.5px)` }}
						onMouseEnter={() => handleEnter(item.id)}
						onMouseLeave={handleLeave}
						onClick={() => handleClick(item.id)}
						aria-label={item.preview || t("chat.userTicksImageOnly")}
					/>
				))}
				{hoveredItem && (
					<div
						ref={popupRef}
						className="pointer-events-auto absolute right-7 w-[min(260px,34vw)] rounded-lg border border-hairline bg-popover p-2.5 shadow-xl"
						style={{ top: popupTop, transform: "translateY(-50%)" }}
						onMouseEnter={() => handleEnter(hoveredItem.id)}
						onMouseLeave={handleLeave}
						onClick={() => handleClick(hoveredItem.id)}
					>
						<div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
							<span className="size-1.5 rounded-full bg-primary/70" aria-hidden="true" />
							{t("chat.you")}
						</div>
						<div className="mt-1 max-h-24 overflow-hidden text-xs leading-relaxed text-popover-foreground/85 line-clamp-4 break-words whitespace-pre-wrap">
							{hoveredItem.preview || <span className="opacity-50">{t("chat.userTicksImageOnly")}</span>}
						</div>
					</div>
				)}
			</div>
		</div>
	);
});
