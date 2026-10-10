import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { cn } from "@look/ui";
import type { LookSessionEntry } from "@shared/types";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { Loader2, MessageSquare } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useScrollPositionManager } from "../../hooks/useScrollPositionMemory";
import { collectTurnEntries, type TimelineItem } from "../../lib/timeline";
import { appStore } from "../../store/appStore";
import {
	activeAgentAtom,
	activeAgentIdAtom,
	activeChatAtBottomAtom,
	activeProjectAtom,
	recentlyCompletedAtom,
	sessionStateAtomFamily,
} from "../../store/atoms";
import type { RendererSessionPhase, RendererSessionState } from "../../store/sessionTypes";
import { messageAlignmentAtom } from "../../store/settingsAtoms";
import { AiAvatar } from "../AiAvatar";
import { BranchConfirmDialog } from "../dialogs/BranchConfirmDialog";
import type { ChatInputHandle } from "./ChatInput";
import { ConversationContent, ConversationScrollButton, useConversationContext } from "./conversation";
import { MessageTicks, userMessagePreview } from "./MessageTicks";
import { messageText } from "./message-text";
import { collectChangedFiles } from "./SessionChangesCard";
import { TimeGreeting } from "./TimeGreeting";
import { TimelineItemRow } from "./TimelineItemRow";
import { useBranchForkActions } from "./useBranchForkActions";
import { useOlderHistoryLoader } from "./useOlderHistoryLoader";
import { useProgressiveTimeline } from "./useProgressiveTimeline";
import { useScrollToMessage } from "./useScrollToMessage";

// ============================================================
// ChatMessagesInner
// 渲染在 Conversation 内部，可以使用 Context。
// ready/transitioning 由外层计算后传入。
// ============================================================

export interface ChatMessagesInnerProps {
	agentId: string;
	agentName?: string;
	sessionState: RendererSessionState;
	timeline: TimelineItem[];
	persistedTimeline: TimelineItem[];
	leafId: string | null;
	phase: RendererSessionPhase;
	isBusy: boolean;
	ready: boolean;
	transitioning: boolean;
	/** Notifies the outer shell when the progressive cold-render chunking phase
	 * starts/stops so the Conversation container can switch resize mode. */
	onChunkingChange?: (chunking: boolean) => void;
	inputRef: React.RefObject<ChatInputHandle | null>;
	onSend: (text: string) => Promise<boolean>;
}

export const ChatMessagesInner = memo(function ChatMessagesInner({
	agentId,
	agentName,
	sessionState,
	timeline,
	persistedTimeline,
	leafId,
	phase,
	isBusy,
	ready,
	transitioning,
	onChunkingChange,
	inputRef,
	onSend,
}: ChatMessagesInnerProps) {
	const { t } = useTranslation();

	// === 尾部优先的渐进渲染 ===
	const lastPersistedTimelineId = persistedTimeline.at(-1)?.id ?? "";
	const historyKey = `${agentId}:${sessionState.historyRevision ?? "unloaded"}:${lastPersistedTimelineId}`;
	const { renderCount, isProgressive } = useProgressiveTimeline(timeline.length, historyKey);
	const visibleTimeline = isProgressive ? timeline.slice(-renderCount) : timeline;

	// Report the progressive cold-render phase to the outer shell so the
	// Conversation container can disable smooth-resize animation while chunks
	// are mounting. Only meaningful when not streaming (cold load / refresh).
	useEffect(() => {
		onChunkingChange?.(isProgressive && !isBusy);
	}, [isProgressive, isBusy, onChunkingChange]);

	// === Conversation context (now safe — we're inside Conversation) ===
	const { isAtBottom, followToBottom, stopScroll, scrollRef } = useConversationContext();

	// 使用 ref 追踪 isAtBottom 最新值，避免 stale closure
	const isAtBottomRef = useRef(isAtBottom);
	isAtBottomRef.current = isAtBottom;

	// === 按需加载更早历史 ===
	const { historyLoading, requestOlderHistory } = useOlderHistoryLoader({
		agentId,
		sessionState,
		scrollRef,
		isAtBottomRef,
		visibleTimelineLength: visibleTimeline.length,
	});

	// === Sync isAtBottom to global atom (debounced to avoid state churn while scrolling) ===
	const setAtBottomAtom = useSetAtom(activeChatAtBottomAtom);
	const activeAgentId = useAtomValue(activeAgentIdAtom);
	// 历史附件卡片打开查看器需要会话所属项目（ChatPanel 以 activeAgent.id 渲染本列表）。
	const activeAgent = useAtomValue(activeAgentAtom);
	const messageAlignment = useAtomValue(messageAlignmentAtom);
	// 只订阅 uiPhase，避免 streaming 期间全量 sessionState 变化触发 re-render
	const activeUiPhaseAtom = useMemo(
		() => atom((get) => get(sessionStateAtomFamily(activeAgentId ?? "__none__")).uiPhase),
		[activeAgentId],
	);
	const activeUiPhase = useAtomValue(activeUiPhaseAtom);
	// biome-ignore lint/correctness/useExhaustiveDependencies: ref + dep trigger re-schedules debounce on change
	useEffect(() => {
		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		const sync = () => {
			timeoutId = null;
			const atBottom = isAtBottomRef.current;
			setAtBottomAtom(atBottom);
			if (atBottom && activeAgentId) {
				appStore.set(
					recentlyCompletedAtom,
					appStore.get(recentlyCompletedAtom).filter((id) => id !== activeAgentId),
				);
			}
		};
		if (!timeoutId) {
			timeoutId = setTimeout(sync, 100);
		}
		return () => {
			if (timeoutId) clearTimeout(timeoutId);
		};
	}, [isAtBottom, setAtBottomAtom, activeAgentId]);

	// === Streaming auto-follow ===
	// 只在 isBusy 翻转时请求一次跟随；流式期间的持续跟随由 Conversation 的
	// ResizeObserver 驱动（resize 动画链 wait:true 复用，不再每批事件打断弹簧
	// 重置速度）。逐批调用 followToBottom 会把动画从零速度重启，输出快时视口
	// 滞后可达一屏以上（对抗性审查模拟：打断 vs 不打断滞后 1660px vs 103px）。
	const wasBusyRef = useRef(isBusy);
	useEffect(() => {
		if (isBusy && !wasBusyRef.current) followToBottom();
		wasBusyRef.current = isBusy;
	}, [isBusy, followToBottom]);

	// === Scroll position memory ===
	useScrollPositionManager(agentId, ready, sessionState.historyStatus);

	// === Scroll to specific message + flash ===
	const { flashEntryId, scrollToMessage, flashEntry } = useScrollToMessage({
		scrollRef,
		timeline,
		visibleTimelineLength: visibleTimeline.length,
		historyStatus: sessionState.historyStatus,
		historyCursor: sessionState.historyCursor,
		requestOlderHistory,
		stopScroll,
	});

	// === Branch / fork state ===
	const {
		navigatingEntry,
		forkingEntry,
		pendingConfirm,
		handleBranchFromHere,
		handleForkToNewChat,
		handleConfirmResolve,
	} = useBranchForkActions({
		agentId,
		isBusy,
		inputRef,
		onSend,
		scrollToMessage,
		flashEntry,
	});

	// === User message ticks（右侧垂直刻度：悬停预览 + 点击跳转）===
	const userTicks = useMemo(
		() =>
			persistedTimeline
				.filter((it) => it.message?.role === "user" && !it.isLive)
				.map((it) => ({ id: it.id, preview: userMessagePreview(it.message!) })),
		[persistedTimeline],
	);

	const handleTickNavigate = useCallback(
		(entryId: string) => {
			scrollToMessage(entryId);
			flashEntry(entryId);
		},
		[scrollToMessage, flashEntry],
	);

	// === Copy message ===
	const [copiedEntryId, setCopiedEntryId] = useState<string | null>(null);
	const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Clean up copy timer on unmount
	useEffect(() => {
		return () => {
			if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
		};
	}, []);

	const handleCopyMessage = useCallback(
		async (id: string, message: AgentMessage) => {
			const text = messageText(message);
			if (!text) return;
			try {
				await navigator.clipboard.writeText(text);
				setCopiedEntryId(id);
				if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
				copyTimerRef.current = setTimeout(() => setCopiedEntryId(null), 1200);
			} catch (error) {
				toast.error(t("chat.copyFailed", { message: error instanceof Error ? error.message : "unknown" }));
			}
		},
		[t],
	);

	const isLoading =
		(sessionState.loadingSnapshot && sessionState.historyStatus === "unloaded") ||
		(sessionState.historyStatus === "unloaded" && !sessionState.snapshotLoaded && sessionState.runtime === null);
	const canShowEmpty =
		sessionState.historyStatus === "complete" || sessionState.snapshotLoaded || sessionState.runtime !== null;
	const showLoading = isLoading && timeline.length === 0;
	const showEmpty = timeline.length === 0 && !isBusy && canShowEmpty;

	const isAgentRunning = activeAgentId ? activeUiPhase !== "idle" : false;
	const activeProjectCwd = useAtomValue(activeProjectAtom)?.cwd ?? "";

	// === Turn-card cache（流式性能） ===
	// collectTurnEntries + collectChangedFiles 在流式期间每帧对每个可见 assistant 行
	// 重新执行（O(可见行数 × 条目数)）。已完成轮次的窗口是 (entries, messageDurations,
	// timeline 前缀, cwd) 的纯函数；applyLiveTimeline 只在尾部追加 live 项（唯一例外是
	// 最后一条 assistant 被 attach 为 live —— isLive 置 true 后本就不参与 turn-card），
	// 因此 entries/messageDurations/cwd 引用不变时结果稳定，即使 timeline 每帧换新引用。
	// 按 turnKey 缓存，快照/分页/分支导航/压缩（entries 或 messageDurations 换引用）时
	// 整体失效；map 值 null 表示"已计算但本轮无变更文件"。
	const turnCardCacheRef = useRef<{
		entries: readonly LookSessionEntry[];
		messageDurations: Record<string, number>;
		cwd: string;
		map: Map<string, { entries: LookSessionEntry[]; projectCwd?: string; turnKey?: string } | null>;
	} | null>(null);
	let turnCardCache = turnCardCacheRef.current;
	if (
		!turnCardCache ||
		turnCardCache.entries !== sessionState.entries ||
		turnCardCache.messageDurations !== sessionState.messageDurations ||
		turnCardCache.cwd !== activeProjectCwd
	) {
		turnCardCache = {
			entries: sessionState.entries,
			messageDurations: sessionState.messageDurations,
			cwd: activeProjectCwd,
			map: new Map(),
		};
		turnCardCacheRef.current = turnCardCache;
	}

	return (
		<>
			<ConversationContent>
				{showLoading ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-4 text-center py-8">
						<div className="relative">
							<AiAvatar status={phase} size="lg" />
							<Loader2 className="absolute -right-2 -bottom-2 size-5 animate-spin rounded-md border border-hairline bg-background p-1 text-foreground" />
						</div>
						<h3 className="text-[13px] font-semibold text-foreground">{t("common.loading")}</h3>
					</div>
				) : showEmpty ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-3 text-center py-8">
						<div className="relative">
							<AiAvatar status={phase} size="lg" />
							<MessageSquare className="absolute -right-2 -bottom-2 size-5 rounded-md border border-hairline bg-background p-1 text-foreground" />
						</div>
						<TimeGreeting />
						<p className="max-w-xs text-xs text-muted-foreground">{t("chat.emptyReassurance")}</p>
					</div>
				) : (
					<>
						{sessionState.historyStatus === "partial" && (
							<div data-history-sentinel className="flex min-h-5 items-center justify-center" aria-hidden="true">
								{historyLoading && <Loader2 className="size-3 animate-spin text-muted-foreground/50" />}
							</div>
						)}
						{visibleTimeline.map((item, index) => {
							const next = visibleTimeline[index + 1];
							const isLast = index === visibleTimeline.length - 1;
							// 轮次变更卡片：内嵌在消息流中，紧跟该轮 assistant bubble 之后。
							// 结束判定：后面紧跟 user 消息（历史轮次已完成），或这是最后一个 item 且会话空闲（本轮已完成）。
							// live/流式中的 assistant 不显示（该轮尚未结束）。
							const showTurnCard =
								item.message?.role === "assistant" &&
								!item.isLive &&
								Boolean(item.entryId) &&
								(next?.message?.role === "user" || (isLast && !isAgentRunning));
							let turnCard: { entries: LookSessionEntry[]; projectCwd?: string; turnKey?: string } | undefined;
							if (showTurnCard) {
								const turnKey = item.entryId ?? item.id;
								const cached = turnCardCache.map.get(turnKey);
								if (cached !== undefined) {
									// null = 已计算但本轮无变更文件（不渲染卡片）
									turnCard = cached ?? undefined;
								} else {
									// 该轮条目从原始 entries 取回，包含被 timeline 附着到 assistant 后面的 toolResult。
									const globalIndex = timeline.findIndex((it) => it.id === item.id);
									const turnEntries = collectTurnEntries(sessionState.entries, timeline, globalIndex);
									// 仅当本轮确有变更文件时才构造卡片（否则占位头像行会在消息与按钮行之间
									// 撑出 ~30px 空白）。collectChangedFiles 与卡片内部 useMemo 同源，结果一致。
									const hasChanges = collectChangedFiles(turnEntries, activeProjectCwd).length > 0;
									turnCard = hasChanges
										? { entries: turnEntries, projectCwd: activeProjectCwd, turnKey }
										: undefined;
									turnCardCache.map.set(turnKey, turnCard ?? null);
								}
							}
							return (
								<TimelineItemRow
									key={item.id}
									item={item}
									turnCard={turnCard}
									agentId={agentId}
									agentName={agentName}
									projectId={activeAgent?.projectId}
									leafId={leafId}
									isBusy={isBusy}
									flashEntryId={flashEntryId}
									copiedEntryId={copiedEntryId}
									messageAlignment={messageAlignment}
									branchBusy={Boolean(navigatingEntry || forkingEntry)}
									onBranch={handleBranchFromHere}
									onFork={handleForkToNewChat}
									onCopy={handleCopyMessage}
								/>
							);
						})}
					</>
				)}
			</ConversationContent>
			<MessageTicks items={userTicks} onNavigate={handleTickNavigate} />
			<ConversationScrollButton className={cn(isAgentRunning && "flowing-border")} />
			<BranchConfirmDialog request={pendingConfirm} onResolve={handleConfirmResolve} />
		</>
	);
});
