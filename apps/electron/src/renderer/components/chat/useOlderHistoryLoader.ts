import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { prependHistoryPage } from "../../store/snapshot";

type HistorySlice = {
	historyStatus: string;
	historyCursor: string | null | undefined;
	historyRevision: string | null | undefined;
};

/**
 * 按需加载更早历史：顶部滚动触发、短尾补页、prepend 后保持视觉锚点。
 */
export function useOlderHistoryLoader(options: {
	agentId: string;
	sessionState: HistorySlice;
	scrollRef: RefObject<HTMLElement | null>;
	isAtBottomRef: RefObject<boolean>;
	visibleTimelineLength: number;
}): {
	historyLoading: boolean;
	requestOlderHistory: () => Promise<void>;
} {
	const { agentId, sessionState, scrollRef, isAtBottomRef, visibleTimelineLength } = options;
	const [historyLoading, setHistoryLoading] = useState(false);
	const historyRequestRef = useRef<string | null>(null);
	const historyErrorRef = useRef<string | null>(null);
	const prependAnchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
	const renderMetricsRef = useRef<{ scrollHeight: number; renderedCount: number } | null>(null);

	const requestOlderHistory = useCallback(async () => {
		if (historyLoading || sessionState.historyStatus !== "partial") return;
		const cursor = sessionState.historyCursor;
		const revision = sessionState.historyRevision;
		if (!cursor || !revision) return;
		const requestKey = `${revision}:${cursor}`;
		if (historyRequestRef.current === requestKey || historyErrorRef.current === requestKey) return;
		const loadHistoryPage = window.look?.loadHistoryPage;
		if (typeof loadHistoryPage !== "function") return;
		historyRequestRef.current = requestKey;
		setHistoryLoading(true);
		try {
			const result = await loadHistoryPage(agentId, cursor, revision);
			if (!result?.success) {
				historyErrorRef.current = requestKey;
				return;
			}
			const scrollElNow = scrollRef.current;
			if (scrollElNow) {
				prependAnchorRef.current = { scrollTop: scrollElNow.scrollTop, scrollHeight: scrollElNow.scrollHeight };
			}
			const accepted = prependHistoryPage(agentId, result, cursor, revision);
			if (!accepted) prependAnchorRef.current = null;
			historyErrorRef.current = null;
		} catch (error) {
			console.warn(`[ChatMessageList] failed to load older history for ${agentId}:`, error);
		} finally {
			historyRequestRef.current = null;
			setHistoryLoading(false);
		}
	}, [
		agentId,
		historyLoading,
		scrollRef,
		sessionState.historyCursor,
		sessionState.historyRevision,
		sessionState.historyStatus,
	]);

	useLayoutEffect(() => {
		const scrollEl = scrollRef.current;
		if (!scrollEl) return;
		const pageAnchor = prependAnchorRef.current;
		const previousMetrics = renderMetricsRef.current;
		if (pageAnchor) {
			prependAnchorRef.current = null;
			if (!isAtBottomRef.current) {
				const delta = scrollEl.scrollHeight - pageAnchor.scrollHeight;
				if (delta > 0) scrollEl.scrollTop = pageAnchor.scrollTop + delta;
			}
		} else if (previousMetrics && visibleTimelineLength > previousMetrics.renderedCount && !isAtBottomRef.current) {
			const delta = scrollEl.scrollHeight - previousMetrics.scrollHeight;
			if (delta > 0) scrollEl.scrollTop += delta;
		}
		renderMetricsRef.current = { scrollHeight: scrollEl.scrollHeight, renderedCount: visibleTimelineLength };
	}, [scrollRef, visibleTimelineLength, isAtBottomRef]);

	useEffect(() => {
		const scrollEl = scrollRef.current;
		if (!scrollEl) return;
		const onScroll = (): void => {
			if (scrollEl.scrollTop < 180) void requestOlderHistory();
		};
		scrollEl.addEventListener("scroll", onScroll, { passive: true });
		return () => scrollEl.removeEventListener("scroll", onScroll);
	}, [requestOlderHistory, scrollRef]);

	useLayoutEffect(() => {
		const scrollEl = scrollRef.current;
		if (!scrollEl || sessionState.historyStatus !== "partial" || historyLoading) return;
		const renderedLength = visibleTimelineLength;
		if (scrollEl.scrollHeight <= scrollEl.clientHeight + 24 || renderedLength === 0) void requestOlderHistory();
	}, [historyLoading, requestOlderHistory, scrollRef, sessionState.historyStatus, visibleTimelineLength]);

	return { historyLoading, requestOlderHistory };
}
