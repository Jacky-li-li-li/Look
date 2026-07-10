/**
 * 滚动位置记忆 — 切换会话时保存并恢复滚动位置
 *
 * 配合 Conversation（StickToBottom）使用：
 * - scroll 事件持续保存 distanceFromBottom 到模块级 Map
 * - 切换会话时 ready=false → Conversation 的 resize 切为 "instant"（消除动画）
 * - ready=true 时：有保存位置 → stopScroll() + 恢复 scrollTop；
 *   有 Branch 导航目标 → 滚动到指定消息；
 *   无保存 → scrollToBottom("instant")
 *
 * 放在 Conversation（StickToBottom）内部使用。
 */

import { useAtomValue } from "jotai";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { navigatingEntryAtomFamily } from "../store/atoms";

/** 模块级缓存：会话 ID → 距底部像素距离 */
const scrollPositionCache = new Map<string, number>();

const DEBUG = true;

/**
 * ScrollPositionManager — 放在 Conversation（StickToBottom）内部
 *
 * @param id     会话/Agent ID，用作缓存 key
 * @param ready  防闪烁 ready 状态，为 true 时才恢复位置
 */
export function useScrollPositionManager(id: string, ready: boolean): void {
	const { scrollRef, stopScroll, scrollToBottom } = useStickToBottomContext();
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
			const target = container.querySelector(`[data-message-id="${entryId}"]`);
			if (target) {
				(target as HTMLElement).scrollIntoView({ block: "center", behavior });
			}
		},
		[scrollRef, stopScroll],
	);

	// ready 后恢复位置
	// 关键：用 rAF 把 scrollToBottom 延迟到下一帧，
	// 确保 StickToBottom 内部的 ResizeObserver 已经处理完本轮布局。
	//
	// 注意：刷新/首次加载时无保存位置 → 不做任何滚动操作，
	// StickToBottom 默认已在底部，额外的 scrollToBottom 反而造成可见跳动。
	useLayoutEffect(() => {
		if (!ready || restoredRef.current) return;
		restoredRef.current = true;

		const el = scrollRef.current;
		if (!el) {
			DEBUG && console.log("[ScrollPos] ready but no scrollRef, id=", id);
			return;
		}

		// Branch 导航优先
		if (navigatingEntry) {
			DEBUG && console.log("[ScrollPos] branch nav to", navigatingEntry);
			scrollToMessage(navigatingEntry, "instant");
			return;
		}

		const savedDistance = scrollPositionCache.get(id);
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
		// StickToBottom 组件在挂载时默认已在底部，额外的滚动调用反而造成可见跳动
	}, [ready, id, navigatingEntry, scrollRef, stopScroll, scrollToMessage]);
}

export { scrollPositionCache };
