/**
 * 滚动位置记忆 — 切换会话时保存并恢复滚动位置
 *
 * 配合 Conversation 使用：
 * - scroll 事件持续保存 distanceFromBottom 到模块级 Map
 * - 切换会话时 ready=false → Conversation 用 opacity-0 隐藏
 * - ready=true 时：有保存位置 → stopScroll() + 恢复 scrollTop；
 *   有 Branch 导航目标 → 滚动到指定消息；
 *   无保存 → 保持底部（Conversation 默认已在底部）
 *
 * 放在 Conversation 内部使用。
 */

import { useAtomValue } from "jotai";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useConversationContext } from "../components/chat/conversation";
import { navigatingEntryAtomFamily } from "../store/atoms";
import type { RendererHistoryStatus } from "../store/sessionTypes";

/** 模块级缓存：会话 ID → 距底部像素距离 */
const scrollPositionCache = new Map<string, number>();
/** 模块级缓存：会话 ID → 加载 partial 尾窗时距底部的比例（0=顶部,1=底部） */
const pendingRestoreRatio = new Map<string, number>();

const DEBUG = false;

/**
 * ScrollPositionManager — 放在 Conversation 内部
 *
 * @param id     会话/Agent ID，用作缓存 key
 * @param ready  防闪烁 ready 状态，为 true 时才恢复位置
 */
export function useScrollPositionManager(
	id: string,
	ready: boolean,
	historyStatus: RendererHistoryStatus = "complete",
): void {
	const { scrollRef, stopScroll, scrollToBottom } = useConversationContext();
	const restoredRef = useRef(false);
	const prevIdRef = useRef(id);

	// Branch 导航目标（如果有，优先级高于保存的位置）
	const navigatingEntry = useAtomValue(navigatingEntryAtomFamily(id));

	// 持续保存滚动位置（距底部距离）
	// 仅在恢复完成后才注册监听，防止恢复前的自动滚动污染缓存
	useEffect(() => {
		if (!ready) return;
		const el = scrollRef.current;
		if (!el || !restoredRef.current) return;

		const savePosition = (): void => {
			const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
			scrollPositionCache.set(id, distanceFromBottom);
		};

		el.addEventListener("scroll", savePosition, { passive: true });
		return () => el.removeEventListener("scroll", savePosition);
	}, [scrollRef, id, ready]);

	// id 变化时重置恢复标记
	useEffect(() => {
		if (id !== prevIdRef.current) {
			prevIdRef.current = id;
			restoredRef.current = false;
		}
	}, [id]);

	/** 滚动到指定消息（Branch 导航用） */
	const scrollToMessage = useCallback(
		(entryId: string, behavior: "instant" | "smooth" = "instant") => {
			const container = scrollRef.current;
			if (!container) return;

			stopScroll();
			const target =
				container.querySelector(`[data-message-id="${entryId}"]`) ??
				Array.from(container.querySelectorAll<HTMLElement>("[data-entry-ids]")).find((element) =>
					element.dataset.entryIds?.split(" ").includes(entryId),
				) ??
				null;
			if (target) {
				(target as HTMLElement).scrollIntoView({ block: "center", behavior });
			}
		},
		[scrollRef, stopScroll],
	);

	// ready 后恢复位置
	// 关键：用 rAF 把 scrollToBottom 延迟到下一帧，
	// 确保 Conversation 内部的 ResizeObserver 已经处理完本轮布局。
	//
	// 注意：刷新/首次加载时无保存位置 → 不做任何滚动操作，
	// Conversation 默认已在底部，额外的 scrollToBottom 反而造成可见跳动。
	//
	// partial 加载时无法按像素恢复（old document height 缺失）：会先记录一个
	// 近似距底部比例，待 historyStatus 变为 complete 且布局稳定后按比例近似恢复。
	useLayoutEffect(() => {
		if (!ready || restoredRef.current) return;
		const savedDistance = scrollPositionCache.get(id);
		const el = scrollRef.current;
		if (!el) {
			DEBUG && console.log("[ScrollPos] ready but no scrollRef, id=", id);
			return;
		}

		// Branch 导航优先
		if (navigatingEntry) {
			restoredRef.current = true;
			DEBUG && console.log("[ScrollPos] branch nav to", navigatingEntry);
			scrollToMessage(navigatingEntry, "instant");
			return;
		}

		// A partial tail does not have the old document height. Record an
		// approximate distance-from-bottom ratio and defer the actual restore
		// until the complete branch/pages arrive. Without this, a partial switch-
		// back would silently stay pinned to the bottom.
		if (historyStatus !== "complete") {
			if (savedDistance != null && savedDistance > 5) {
				const ratio =
					el.scrollHeight > el.clientHeight ? Math.min(1, savedDistance / (el.scrollHeight - el.clientHeight)) : 1;
				pendingRestoreRatio.set(id, ratio);
			}
			return;
		}

		restoredRef.current = true;

		// Restore from a deferred partial ratio if the user was not at the bottom.
		const deferredRatio = pendingRestoreRatio.get(id);
		if (deferredRatio != null && deferredRatio < 1) {
			pendingRestoreRatio.delete(id);
			stopScroll();
			requestAnimationFrame(() => {
				const reachable = el.scrollHeight - el.clientHeight;
				if (reachable > 0) el.scrollTop = Math.max(0, reachable - reachable * deferredRatio);
			});
			return;
		}
		pendingRestoreRatio.delete(id);

		DEBUG &&
			console.log(
				"[ScrollPos] ready, id=",
				id,
				"savedDistance=",
				savedDistance,
				"scrollHeight=",
				el.scrollHeight,
				"clientHeight=",
				el.clientHeight,
				"scrollTop=",
				el.scrollTop,
			);

		if (savedDistance != null && savedDistance > 5) {
			if (savedDistance <= 70) {
				// 距底 ≤70px（库的"近底"容差内）→ 直接贴底恢复，不再 stopScroll。
				// 否则 stopScroll 会强制 isAtBottom=false，而恢复瞬间的 scroll 事件
				// 在内容重渲染（ResizeObserver 高频触发）时会被 resizeDifference 吞掉，
				// 导致贴底状态卡死：流式不跟随、输出完不贴底且无回底按钮。
				void scrollToBottom();
				return;
			}
			// 有保存的滚动位置 → 恢复
			stopScroll();
			const targetScrollTop = el.scrollHeight - el.clientHeight - savedDistance;
			el.scrollTop = Math.max(0, targetScrollTop);
			requestAnimationFrame(() => {
				const t = el.scrollHeight - el.clientHeight - savedDistance;
				el.scrollTop = Math.max(0, t);
			});
		}
		// 无保存位置时（刷新/首次加载）不调用 scrollToBottom：
		// Conversation 组件在挂载时默认已在底部，额外的滚动调用反而造成可见跳动
	}, [ready, id, historyStatus, navigatingEntry, scrollRef, stopScroll, scrollToMessage, scrollToBottom]);

	// historyStatus 从 partial 变 complete 但 ready 早已 true（分页填满后、
	// 组件重挂载后）时，消费 deferred 比例并近似恢复。
	useLayoutEffect(() => {
		if (!ready || !restoredRef.current) return;
		if (historyStatus !== "complete") return;
		const ratio = pendingRestoreRatio.get(id);
		if (ratio == null || ratio >= 1) return;
		const el = scrollRef.current;
		if (!el) return;
		pendingRestoreRatio.delete(id);
		stopScroll();
		const reachable = el.scrollHeight - el.clientHeight;
		el.scrollTop = Math.max(0, reachable - reachable * ratio);
	}, [ready, id, historyStatus, scrollRef, stopScroll]);
}

export { scrollPositionCache, pendingRestoreRatio };
