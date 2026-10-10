import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { cn } from "@look/ui";
import type { LookSessionEntry, LookUiToolExecState } from "@shared/types";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { Loader2, MessageSquare } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
	forkingEntryAtomFamily,
	navigatingEntryAtomFamily,
	recentlyCompletedAtom,
	sessionStateAtomFamily,
} from "../../store/atoms";
import type { RendererSessionPhase, RendererSessionState } from "../../store/sessionTypes";
import { messageAlignmentAtom } from "../../store/settingsAtoms";
import { prependHistoryPage } from "../../store/snapshot";
import { AiAvatar } from "../AiAvatar";
import {
	BranchConfirmDialog,
	type BranchConfirmRequest,
	type BranchConfirmResult,
} from "../dialogs/BranchConfirmDialog";
import type { ChatInputHandle } from "./ChatInput";
import { CompactionStatusCard } from "./CompactionStatusCard";
import { ConversationContent, ConversationScrollButton, useConversationContext } from "./conversation";
import { MessageItem } from "./MessageItem";
import { MessageTicks, userMessagePreview } from "./MessageTicks";
import { MessageActions } from "./message-elements/MessageActions";
import { messageText } from "./message-text";
import SessionChangesCard, { collectChangedFiles } from "./SessionChangesCard";
import { SessionEntryBubble } from "./SessionEntryBubble";
import { TimeGreeting } from "./TimeGreeting";
import { useProgressiveTimeline } from "./useProgressiveTimeline";
import { useScrollToMessage } from "./useScrollToMessage";

/** 模块级空对象常量，避免 JSX 内联 {} 破坏 React.memo */
const EMPTY_TOOL_EXECUTIONS: Record<string, LookUiToolExecState> = {};

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
	const renderMetricsRef = useRef<{ scrollHeight: number; renderedCount: number } | null>(null);

	// === 按需加载更早历史 ===
	const [historyLoading, setHistoryLoading] = useState(false);
	const historyRequestRef = useRef<string | null>(null);
	const historyErrorRef = useRef<string | null>(null);
	const prependAnchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);

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
			// Re-sample the scroll anchor immediately before applying the page: the
			// user may have kept scrolling while the request was in flight, so the
			// anchor captured at request time would be stale and cause a jump.
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

	// When older rows are inserted above the viewport, retain the user's visual
	// anchor. At the bottom use-stick-to-bottom remains the source of truth.
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
		} else if (previousMetrics && visibleTimeline.length > previousMetrics.renderedCount && !isAtBottomRef.current) {
			const delta = scrollEl.scrollHeight - previousMetrics.scrollHeight;
			if (delta > 0) scrollEl.scrollTop += delta;
		}
		renderMetricsRef.current = { scrollHeight: scrollEl.scrollHeight, renderedCount: visibleTimeline.length };
	}, [scrollRef, visibleTimeline.length]);

	useEffect(() => {
		const scrollEl = scrollRef.current;
		if (!scrollEl) return;
		const onScroll = (): void => {
			if (scrollEl.scrollTop < 180) void requestOlderHistory();
		};
		scrollEl.addEventListener("scroll", onScroll, { passive: true });
		return () => scrollEl.removeEventListener("scroll", onScroll);
	}, [requestOlderHistory, scrollRef]);

	// A short tail may not fill the viewport. Pull another page until the user
	// has a meaningful scroll surface or the branch is exhausted.
	useLayoutEffect(() => {
		const scrollEl = scrollRef.current;
		if (!scrollEl || sessionState.historyStatus !== "partial" || historyLoading) return;
		const renderedLength = visibleTimeline.length;
		if (scrollEl.scrollHeight <= scrollEl.clientHeight + 24 || renderedLength === 0) void requestOlderHistory();
	}, [historyLoading, requestOlderHistory, scrollRef, sessionState.historyStatus, visibleTimeline.length]);

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

	// === Branch / fork state ===
	const navigatingEntry = useAtomValue(navigatingEntryAtomFamily(agentId));
	const forkingEntry = useAtomValue(forkingEntryAtomFamily(agentId));
	const [pendingConfirm, setPendingConfirm] = useState<BranchConfirmRequest | null>(null);
	const [pendingBranchEntryId, setPendingBranchEntryId] = useState<string | null>(null);

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

	const handleBranchFromHere = useCallback(
		(entryId: string) => {
			if (isBusy) return void toast(t("chat.stopFirstToNavigate"));
			if (navigatingEntry || forkingEntry) return;
			setPendingBranchEntryId(entryId);
			setPendingConfirm(inputRef.current?.getText().trim() ? { kind: "input-not-empty" } : { kind: "summary" });
		},
		[isBusy, navigatingEntry, forkingEntry, inputRef, t],
	);

	const handleForkToNewChat = useCallback(
		async (entryId: string) => {
			if (isBusy) return void toast(t("chat.stopFirstToNavigate"));
			if (navigatingEntry || forkingEntry) return;
			appStore.set(forkingEntryAtomFamily(agentId), entryId);
			const toastId = toast.loading(t("chat.forking"));
			try {
				const result = await window.look.createFork(agentId, entryId, {});
				toast.dismiss(toastId);
				if (!result?.success) throw new Error(result?.error ?? "unknown");
				if (result.agentId) appStore.set(activeAgentIdAtom, result.agentId);
				toast.success(t("chat.forkCreated"), { duration: 1500 });
			} catch (error) {
				toast.dismiss(toastId);
				toast.error(t("chat.forkFailed", { message: error instanceof Error ? error.message : "unknown" }));
			} finally {
				// 成功/失败都必须复位：旧实现只在失败路径复位，成功路径残留
				// entryId，后续所有分支/复刻操作被 if (navigatingEntry || forkingEntry) 静默拦截。
				appStore.set(forkingEntryAtomFamily(agentId), null);
			}
		},
		[agentId, forkingEntry, isBusy, navigatingEntry, t],
	);

	const handleConfirmResolve = useCallback(
		async (result: BranchConfirmResult) => {
			const entryId = pendingBranchEntryId;
			const confirm = pendingConfirm;
			setPendingConfirm(null);
			setPendingBranchEntryId(null);
			if (!entryId || !confirm || result.kind === "summary-cancel" || result.kind === "input-cancel") return;
			if (confirm.kind === "input-not-empty" && result.kind === "input-send-first") {
				const draft = inputRef.current?.getText().trim() ?? "";
				if (draft && (await onSend(draft))) inputRef.current?.setText("");
				setPendingBranchEntryId(entryId);
				setPendingConfirm({ kind: "summary" });
				return;
			}
			appStore.set(navigatingEntryAtomFamily(agentId), entryId);
			const toastId = toast.loading(t("chat.navigating"));
			try {
				const response = await window.look.navigateTree(agentId, entryId, {
					summarize: result.kind === "summary-generate",
				});
				toast.dismiss(toastId);
				if (!response?.success) throw new Error(response?.error ?? "unknown");
				if (response.result?.cancelled) return;
				if (typeof response.result?.editorText === "string") {
					inputRef.current?.setText(response.result.editorText);
					inputRef.current?.focus();
				}
				scrollToMessage(entryId);
				flashEntry(entryId);
				toast.success(t("chat.branched"), { duration: 1500 });
			} catch (error) {
				toast.dismiss(toastId);
				toast.error(t("chat.navigatingFailed", { message: error instanceof Error ? error.message : "unknown" }));
				appStore.set(navigatingEntryAtomFamily(agentId), null);
			}
		},
		[pendingBranchEntryId, pendingConfirm, inputRef, onSend, agentId, t, scrollToMessage, flashEntry],
	);

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

	// === Render timeline item ===
	const renderTimelineItem = useCallback(
		(item: TimelineItem, turnCard?: { entries: LookSessionEntry[]; projectCwd?: string; turnKey?: string }) => {
			if (!item) return null;

			// Compaction status card (live or persisted).
			if (item.compactionPhase) {
				return (
					<CompactionStatusCard
						key={item.id}
						phase={item.compactionPhase}
						summary={item.compactionSummary}
						tokensBefore={item.compactionTokensBefore}
						estimatedTokensAfter={item.compactionEstimatedTokensAfter}
						sessionId={agentId}
					/>
				);
			}

			if (item.entry) {
				return (
					<div key={item.id} className="px-msg-item-x py-msg-item-y">
						<SessionEntryBubble entry={item.entry} />
					</div>
				);
			}

			// 统一消息渲染：快照 / live / 纯 live 全部走 MessageItem。
			// MessageItem 内部用原语组装，isStreaming 与 liveBlocks 是状态而非另一棵树。
			// 注意 live 用 item.isLive 而非 Boolean(uiBlocks?.length)：纯 live 且
			// 空数组（assistant_message_start 后、首个 block 前）也要传 liveBlocks=[]，
			// 由 StreamingBlocksBubble 显示 loading 指示（与旧行为一致）。
			if (item.message || (item.isLive && item.uiBlocks)) {
				const itemEntryId = item.entryId;
				const actionEntryId = item.secondaryEntryIds?.at(-1) ?? itemEntryId;
				const anchorEntryIds = [item.id, itemEntryId, ...(item.secondaryEntryIds ?? [])].filter(
					(id): id is string => Boolean(id),
				);
				const live = item.isLive;
				return (
					<div key={item.id} className="msg-row px-msg-item-x py-msg-item-y">
						<div
							data-message-id={item.id}
							data-entry-ids={anchorEntryIds.join(" ")}
							className="group/message flex flex-col"
						>
							<MessageItem
								message={item.message}
								entryId={itemEntryId}
								blockCacheKey={
									itemEntryId
										? `${agentId}:${[itemEntryId, ...(item.secondaryEntryIds ?? [])].join("|")}`
										: undefined
								}
								agentName={agentName}
								sessionId={agentId}
								projectId={activeAgent?.projectId}
								isStreaming={live ? isBusy : false}
								toolExecutions={EMPTY_TOOL_EXECUTIONS}
								toolResultMap={item.toolResultMap}
								isActiveLeaf={Boolean(actionEntryId && actionEntryId === leafId)}
								flash={flashEntryId === item.id}
								liveBlocks={live ? item.uiBlocks : undefined}
								liveToolExecutions={live ? (item.uiTools ?? EMPTY_TOOL_EXECUTIONS) : EMPTY_TOOL_EXECUTIONS}
							/>
							{turnCard && (
								<div className="flex w-full max-w-[98%] gap-msg-bubble">
									<div className="mt-msg-avatar size-7 shrink-0" aria-hidden="true" />
									<div className="min-w-0 flex-1">
										<SessionChangesCard
											entries={turnCard.entries}
											projectCwd={turnCard.projectCwd}
											agentId={agentId}
											turnKey={turnCard.turnKey}
										/>
									</div>
								</div>
							)}
							<MessageActions
								// 旧版仅 assistant/user 显示操作按钮；live 项只保留占位（reserve），
								// 快照落定前不显示可操作按钮。
								show={
									!live &&
									Boolean(itemEntryId) &&
									Boolean(item.message) &&
									(item.message?.role === "assistant" || item.message?.role === "user")
								}
								isUser={item.message?.role === "user"}
								alignment={messageAlignment}
								busy={isBusy || Boolean(navigatingEntry || forkingEntry)}
								onBranch={actionEntryId ? () => handleBranchFromHere(actionEntryId) : undefined}
								onFork={
									item.message && item.message.role !== "user" && actionEntryId
										? () => handleForkToNewChat(actionEntryId)
										: undefined
								}
								onCopy={item.message ? () => handleCopyMessage(item.id, item.message!) : undefined}
								copied={copiedEntryId === item.id}
								labels={{
									branch: t("chat.branchFromHere"),
									fork: t("chat.forkToNewChat"),
									copy: t("chat.copyMessage"),
								}}
								meta={
									item.message &&
									item.message.role === "assistant" &&
									item.turnDurationMs != null &&
									item.turnDurationMs > 0 ? (
										<span className="font-mono text-[10px] text-muted-foreground/60 tabular-nums">
											{item.turnDurationMs >= 60_000
												? `${(item.turnDurationMs / 60_000).toFixed(1)}m`
												: `${(item.turnDurationMs / 1_000).toFixed(1)}s`}
										</span>
									) : undefined
								}
							/>
						</div>
					</div>
				);
			}

			return null;
		},
		[
			agentName,
			flashEntryId,
			isBusy,
			leafId,
			copiedEntryId,
			navigatingEntry,
			forkingEntry,
			handleBranchFromHere,
			handleForkToNewChat,
			handleCopyMessage,
			t,
			agentId,
			messageAlignment,
			activeAgent?.projectId,
		],
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
							return renderTimelineItem(item, turnCard);
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
