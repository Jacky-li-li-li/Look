import { cn } from "@look/ui";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { applyLiveTimeline, buildPersistedTimeline, type TimelineItem } from "../../lib/timeline";
import type { RendererSessionPhase, RendererSessionState } from "../../store/sessionTypes";
import type { ChatInputHandle } from "./ChatInput";
import { ChatMessagesInner } from "./ChatMessagesInner";
import { Conversation } from "./conversation";
import { CHUNK_SIZE } from "./useProgressiveTimeline";

interface ChatMessageListProps {
	agentId: string;
	agentName?: string;
	sessionState: RendererSessionState;
	phase: RendererSessionPhase;
	isBusy: boolean;
	inputRef: React.RefObject<ChatInputHandle | null>;
	onSend: (text: string) => Promise<boolean>;
}

// ============================================================
// ChatMessageList — 外层
// 负责 timeline 推导 + ready/transitioning 状态 + Conversation 外壳
// ============================================================

const ChatMessageList = memo(function ChatMessageList(props: ChatMessageListProps) {
	const { agentId, sessionState, isBusy } = props;

	// Persisted history is the expensive, immutable half. Build it only when
	// entries/durations change; streaming UI events are a cheap overlay.
	const persistedTimeline = useMemo<TimelineItem[]>(
		() =>
			buildPersistedTimeline(
				sessionState.entries,
				sessionState.messageDurations,
				sessionState.runtime?.compactionEstimatedTokensAfter,
			),
		[sessionState.entries, sessionState.messageDurations, sessionState.runtime?.compactionEstimatedTokensAfter],
	);
	const timeline = useMemo<TimelineItem[]>(
		() =>
			applyLiveTimeline(
				persistedTimeline,
				sessionState.uiBlocks,
				sessionState.uiTools,
				sessionState.uiPhase,
				sessionState.pendingUserMessage,
			),
		[
			persistedTimeline,
			sessionState.uiBlocks,
			sessionState.uiTools,
			sessionState.uiPhase,
			sessionState.pendingUserMessage,
		],
	);

	const { leafId } = sessionState;

	// Progressive cold-render chunking phase, reported by ChatMessagesInner.
	// While true the Conversation container uses instant resize so the chunked
	// mount of older rows above the viewport never animates a visible scroll.
	// Initial value is derived from the timeline length so the FIRST render
	// frame already uses instant resize — the inner effect only reports later
	// transitions, leaving the first frame smooth would animate once.
	const [chunking, setChunking] = useState(() => timeline.length > CHUNK_SIZE);
	const prevChunkAgentRef = useRef(agentId);
	useEffect(() => {
		if (agentId !== prevChunkAgentRef.current) {
			prevChunkAgentRef.current = agentId;
			setChunking(false);
		}
	}, [agentId]);

	// 流式结束过渡：isBusy 刚翻转 false 时保持 instant 滚动一小段。agent_end
	// 快照在同一渲染周期内清空 uiBlocks、折叠 thinking/toolcall 分组、移除状态行
	// —— 内容高度骤变。若此刻 resize 已切回 smooth，库的弹簧会用动画追赶高度突变，
	// 造成视口回弹抖动。保持 instant 让高度变化即时同步，稳定后再切回 smooth。
	const [endTransition, setEndTransition] = useState(false);
	const prevBusyRef = useRef(isBusy);
	useEffect(() => {
		if (prevBusyRef.current && !isBusy) {
			setEndTransition(true);
			const timer = setTimeout(() => setEndTransition(false), 450);
			return () => clearTimeout(timer);
		}
		prevBusyRef.current = isBusy;
	}, [isBusy]);

	// === Anti-flash ready state ===
	const [ready, setReady] = useState(false);
	const prevAgentIdRef = useRef(agentId);

	useEffect(() => {
		if (agentId !== prevAgentIdRef.current) {
			prevAgentIdRef.current = agentId;
			// 目标会话已加载过快照：直接 ready，跳过 opacity 0→1 防闪烁过渡，
			// 快速切换已打开会话时避免闪白/抖动。仅首次加载或冷启动才走防闪烁。
			setReady(sessionState.historyStatus !== "unloaded" || sessionState.snapshotLoaded);
		}
	}, [agentId, sessionState.historyStatus, sessionState.snapshotLoaded]);

	useEffect(() => {
		if (ready) return;

		// 必须等快照加载完毕或 runtime 已创建，否则 sessionState 可能处于中间状态
		// （loadingSnapshot 已完成但 snapshot entries 尚未应用）
		const isLoading =
			(sessionState.loadingSnapshot && sessionState.historyStatus === "unloaded") ||
			(sessionState.historyStatus === "unloaded" && !sessionState.snapshotLoaded && sessionState.runtime === null);
		if (isLoading) return;

		// 关键修复：空消息判断必须确认 snapshot 已加载或 runtime 已就绪，
		// 防止在中间状态（runtime 已创建但 entries 还未应用）时过早 setReady(true)
		const dataReady =
			sessionState.historyStatus !== "unloaded" || sessionState.snapshotLoaded || sessionState.runtime !== null;
		const emptyStateReady =
			sessionState.historyStatus === "complete" || sessionState.snapshotLoaded || sessionState.runtime !== null;
		if (timeline.length === 0 && !isBusy && emptyStateReady) {
			setReady(true);
			return;
		}

		// 如果数据还没准备好，继续等待
		if (!dataReady) return;

		let cancelled = false;
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (!cancelled) setReady(true);
			});
		});
		return () => {
			cancelled = true;
		};
	}, [
		ready,
		sessionState.loadingSnapshot,
		sessionState.historyStatus,
		sessionState.snapshotLoaded,
		sessionState.runtime,
		timeline.length,
		isBusy,
	]);

	return (
		<Conversation
			key={agentId}
			// agent 运行中（流式输出/思考/工具执行）内容每帧增长：instant 即时同步滚动，
			// 视口钉在底部让内容平滑流出，避免 smooth 弹簧追赶造成视口跳动；
			// 静止时保持 smooth 平滑滚动体验。chunking/未 ready 同样 instant（冷渲染分块）。
			// syncSticky：流式期间同帧同步贴底，消除库 rAF 一帧滞后造成的蹦跳。
			// endTransition：流式结束后 450ms 保持 instant，吸收状态行消失/分组
			// 折叠造成的高度突变，避免 smooth 弹簧回弹抖动（见上方 endTransition 注释）。
			resize={isBusy || endTransition || chunking || !ready ? "instant" : "smooth"}
			syncSticky={isBusy}
			className={cn(ready ? "opacity-100" : "opacity-0", "min-h-0 flex-1")}
		>
			<ChatMessagesInner
				agentId={props.agentId}
				agentName={props.agentName}
				sessionState={sessionState}
				timeline={timeline}
				persistedTimeline={persistedTimeline}
				leafId={leafId}
				phase={props.phase}
				isBusy={isBusy}
				ready={ready}
				transitioning={false}
				onChunkingChange={setChunking}
				inputRef={props.inputRef}
				onSend={props.onSend}
			/>
		</Conversation>
	);
});

export default ChatMessageList;
