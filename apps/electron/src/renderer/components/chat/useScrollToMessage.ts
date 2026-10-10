import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { TimelineItem } from "../../lib/timeline";

/**
 * 定位到指定消息：处理渐进窗口未挂载、历史未加载完、超时近似放弃等路径，
 * 并提供 flash 高亮辅助。
 */
export function useScrollToMessage(options: {
	scrollRef: RefObject<HTMLElement | null>;
	timeline: TimelineItem[];
	visibleTimelineLength: number;
	historyStatus: string;
	historyCursor: string | null | undefined;
	requestOlderHistory: () => void | Promise<void>;
	stopScroll: () => void;
}) {
	const { scrollRef, timeline, visibleTimelineLength, historyStatus, historyCursor, requestOlderHistory, stopScroll } =
		options;

	const pendingScrollTargetRef = useRef<string | null>(null);
	const pendingScrollDeadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [flashEntryId, setFlashEntryId] = useState<string | null>(null);
	const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (pendingScrollDeadlineRef.current) clearTimeout(pendingScrollDeadlineRef.current);
			if (flashTimer.current) clearTimeout(flashTimer.current);
		},
		[],
	);

	const tryScrollToPendingTarget = useCallback(() => {
		const entryId = pendingScrollTargetRef.current;
		const container = scrollRef.current;
		if (!entryId || !container) return;
		const target =
			container.querySelector(`[data-message-id="${entryId}"]`) ??
			Array.from(container.querySelectorAll<HTMLElement>("[data-entry-ids]")).find((element) =>
				element.dataset.entryIds?.split(" ").includes(entryId),
			) ??
			null;
		if (target) {
			pendingScrollTargetRef.current = null;
			if (pendingScrollDeadlineRef.current) clearTimeout(pendingScrollDeadlineRef.current);
			pendingScrollDeadlineRef.current = null;
			(target as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
			return;
		}

		if (historyStatus !== "complete") {
			void requestOlderHistory();
			return;
		}
		const timelineIndex = timeline.findIndex(
			(item) => item.id === entryId || item.entryId === entryId || item.secondaryEntryIds?.includes(entryId),
		);
		const progressivelyMounted = timelineIndex >= 0 && timeline.length - timelineIndex <= visibleTimelineLength;
		if (timelineIndex >= 0 && !progressivelyMounted) {
			if (pendingScrollDeadlineRef.current == null) {
				pendingScrollDeadlineRef.current = setTimeout(() => {
					if (pendingScrollTargetRef.current !== entryId) return;
					tryScrollToPendingTarget();
				}, 400);
			}
			return;
		}
		pendingScrollTargetRef.current = null;
		if (pendingScrollDeadlineRef.current) {
			clearTimeout(pendingScrollDeadlineRef.current);
			pendingScrollDeadlineRef.current = null;
		}
	}, [requestOlderHistory, scrollRef, historyStatus, timeline, visibleTimelineLength]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: visibleTimelineLength drives re-mount retry
	useEffect(() => {
		if (!pendingScrollTargetRef.current || (timeline.length === 0 && !historyCursor)) return;
		const frameId = requestAnimationFrame(tryScrollToPendingTarget);
		return () => cancelAnimationFrame(frameId);
	}, [timeline.length, visibleTimelineLength, historyCursor, tryScrollToPendingTarget]);

	const scrollToMessage = useCallback(
		(entryId: string) => {
			stopScroll();
			pendingScrollTargetRef.current = entryId;
			if (pendingScrollDeadlineRef.current) clearTimeout(pendingScrollDeadlineRef.current);
			pendingScrollDeadlineRef.current = null;
			requestAnimationFrame(tryScrollToPendingTarget);
		},
		[stopScroll, tryScrollToPendingTarget],
	);

	const flashEntry = useCallback((entryId: string) => {
		setFlashEntryId(entryId);
		if (flashTimer.current) clearTimeout(flashTimer.current);
		flashTimer.current = setTimeout(() => setFlashEntryId(null), 900);
	}, []);

	return { flashEntryId, scrollToMessage, flashEntry };
}
