import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { cn } from "@look/ui";
import type { LookUiToolExecState } from "@shared/types";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { Check, ChevronDown, ChevronUp, Loader2, MessageSquare } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useScrollPositionManager } from "../../hooks/useScrollPositionMemory";
import { buildTimeline, type TimelineItem } from "../../lib/timeline";
import {
	activeAgentIdAtom,
	activeChatAtBottomAtom,
	forkingEntryAtomFamily,
	navigatingEntryAtomFamily,
	recentlyCompletedAtom,
	sessionStateAtomFamily,
} from "../../store/atoms";
import { isLoggedInAtom, userProfileAtom } from "../../store/authAtoms";
import { appStore } from "../../store/ipcHandler";
import type { RendererSessionPhase, RendererSessionState } from "../../store/sessionTypes";
import { AiAvatar } from "../AiAvatar";
import {
	BranchConfirmDialog,
	type BranchConfirmRequest,
	type BranchConfirmResult,
} from "../dialogs/BranchConfirmDialog";
import LookMarkdown from "../markdown/LookMarkdown";
import type { ChatInputHandle } from "./ChatInput";
import { Conversation, ConversationContent, ConversationScrollButton, useConversationContext } from "./conversation";
import { MessageItem } from "./MessageItem";
import { MessageActions } from "./message-elements/MessageActions";
import { SessionEntryBubble } from "./SessionEntryBubble";

/** 模块级空对象常量，避免 JSX 内联 {} 破坏 React.memo */
const EMPTY_TOOL_EXECUTIONS: Record<string, LookUiToolExecState> = {};

interface ChatMessageListProps {
	agentId: string;
	agentName?: string;
	sessionState: RendererSessionState;
	autoCollapse: boolean;
	phase: RendererSessionPhase;
	isBusy: boolean;
	inputRef: React.RefObject<ChatInputHandle | null>;
	onSend: (text: string) => Promise<boolean>;
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return `${n}`;
}

function _fmtUsage(message: AssistantMessage): string {
	const parts = [fmtTokens(message.usage.totalTokens)];
	if (message.usage.cost.total > 0)
		parts.push(
			message.usage.cost.total < 0.01 ? message.usage.cost.total.toFixed(4) : message.usage.cost.total.toFixed(2),
		);
	return parts.join(" · ");
}

function messageText(message: AgentMessage): string {
	if (message.role === "bashExecution") return `$ ${message.command}\n${message.output}`.trim();
	if (message.role === "branchSummary" || message.role === "compactionSummary") return message.summary.trim();
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content.trim();
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n\n")
		.trim();
}

// ============================================================
// TimeGreeting — 空状态的时段问候
// 每 60s 刷新一次，跨时段（如半夜跨入清晨）自动切换文案；
// 0–5 点归入"深夜"档，不再误判为早上。
// ============================================================

function TimeGreeting() {
	const { t } = useTranslation();
	const isLoggedIn = useAtomValue(isLoggedInAtom);
	const { userName } = useAtomValue(userProfileAtom);
	const [hour, setHour] = useState(() => new Date().getHours());

	useEffect(() => {
		const id = setInterval(() => setHour(new Date().getHours()), 60_000);
		return () => clearInterval(id);
	}, []);

	const hourKey =
		hour < 5
			? "chat.greetingNight"
			: hour < 12
				? "chat.greetingMorning"
				: hour < 18
					? "chat.greetingAfternoon"
					: "chat.greetingEvening";

	return (
		<h3 className="text-[13px] font-semibold text-foreground">
			{isLoggedIn && userName ? t(hourKey, { name: userName }) : t("chat.greetingNoName")}
		</h3>
	);
}

// ============================================================
// CompactionStatusCard — 压缩状态指示条
// ============================================================

function CompactionStatusCard({
	phase,
	summary,
	tokensBefore,
	estimatedTokensAfter,
	sessionId,
}: {
	phase: "compacting" | "done";
	summary?: string;
	tokensBefore?: number;
	estimatedTokensAfter?: number;
	sessionId?: string;
}) {
	const [expanded, setExpanded] = useState(false);
	const { t } = useTranslation();

	const handleAbort = useCallback(() => {
		if (sessionId) {
			window.look
				.abortCompressSession(sessionId)
				.catch((err: unknown) => console.error("[CompactionStatusCard] abort failed:", err));
		}
	}, [sessionId]);

	if (phase === "compacting") {
		return (
			<div className="px-msg-item-x py-msg-item-y">
				<div className="flex select-none items-center gap-3 text-[11px] text-muted-foreground/60">
					<div className="h-px flex-1 bg-gradient-to-r from-transparent via-muted-foreground/30 to-muted-foreground/10" />
					<Loader2 className="size-3 animate-spin" />
					<span>{t("context.compressing")}</span>
					<button
						type="button"
						onClick={handleAbort}
						className="ml-2 rounded-xs px-1.5 py-0.5 text-[10px] text-muted-foreground/40 transition-colors hover:bg-destructive/10 hover:text-destructive"
					>
						{t("common.cancel")}
					</button>
					<div className="h-px flex-1 bg-gradient-to-r from-muted-foreground/10 via-muted-foreground/30 to-transparent" />
				</div>
			</div>
		);
	}

	return (
		<div className="px-msg-item-x py-msg-item-y">
			<button type="button" onClick={() => setExpanded(!expanded)} className="group w-full text-left">
				<div className="flex select-none items-center gap-3 text-[11px] text-muted-foreground/50 transition-colors hover:text-muted-foreground/80">
					<div className="h-px flex-1 bg-gradient-to-r from-transparent via-muted-foreground/20 to-muted-foreground/10" />
					<div className="flex items-center gap-1.5">
						<Check className="size-3 text-emerald-400" />
						<span>{t("context.compressed")}</span>
						{tokensBefore != null && tokensBefore > 0 && (
							<span className="ml-1 font-mono text-[10px] tabular-nums text-muted-foreground/40">
								{estimatedTokensAfter != null
									? `${fmtTokens(tokensBefore)} → ${fmtTokens(estimatedTokensAfter)}`
									: `-${fmtTokens(tokensBefore)}`}
							</span>
						)}
						{summary &&
							(expanded ? (
								<ChevronUp className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
							) : (
								<ChevronDown className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
							))}
					</div>
					<div className="h-px flex-1 bg-gradient-to-r from-muted-foreground/10 via-muted-foreground/20 to-transparent" />
				</div>
			</button>
			{expanded && summary && (
				<div className="mt-2 overflow-hidden rounded-md border border-hairline bg-muted/20 p-3">
					<div className="max-h-80 overflow-auto">
						<LookMarkdown content={summary} />
					</div>
				</div>
			)}
		</div>
	);
}

// ============================================================
// ChatMessagesInner
// 渲染在 Conversation 内部，可以使用 Context。
// ready/transitioning 由外层计算后传入。
// ============================================================

interface ChatMessagesInnerProps {
	agentId: string;
	agentName?: string;
	sessionState: RendererSessionState;
	timeline: TimelineItem[];
	leafId: string | null;
	autoCollapse: boolean;
	phase: RendererSessionPhase;
	isBusy: boolean;
	ready: boolean;
	transitioning: boolean;
	inputRef: React.RefObject<ChatInputHandle | null>;
	onSend: (text: string) => Promise<boolean>;
}

const ChatMessagesInner = memo(function ChatMessagesInner({
	agentId,
	agentName,
	sessionState,
	timeline,
	leafId,
	autoCollapse,
	phase,
	isBusy,
	ready,
	transitioning,
	inputRef,
	onSend,
}: ChatMessagesInnerProps) {
	const { t } = useTranslation();

	// === Conversation context (now safe — we're inside Conversation) ===
	const { isAtBottom, followToBottom, stopScroll, scrollRef } = useConversationContext();

	// 使用 ref 追踪 isAtBottom 最新值，避免 stale closure
	const isAtBottomRef = useRef(isAtBottom);
	isAtBottomRef.current = isAtBottom;

	// === Sync isAtBottom to global atom (debounced to avoid state churn while scrolling) ===
	const setAtBottomAtom = useSetAtom(activeChatAtBottomAtom);
	const activeAgentId = useAtomValue(activeAgentIdAtom);
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: live block/tool reference changes are the follow signal
	useEffect(() => {
		if (isBusy) followToBottom();
	}, [isBusy, sessionState.uiBlocks, sessionState.uiTools, followToBottom]);

	// === Branch / fork state ===
	const navigatingEntry = useAtomValue(navigatingEntryAtomFamily(agentId));
	const forkingEntry = useAtomValue(forkingEntryAtomFamily(agentId));
	const [pendingConfirm, setPendingConfirm] = useState<BranchConfirmRequest | null>(null);
	const [pendingBranchEntryId, setPendingBranchEntryId] = useState<string | null>(null);

	// === Scroll position memory ===
	useScrollPositionManager(agentId, ready);

	// === Flash entry highlight ===
	const [flashEntryId, setFlashEntryId] = useState<string | null>(null);
	const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (flashTimer.current) clearTimeout(flashTimer.current);
		},
		[],
	);

	// === Scroll to specific message ===
	const scrollToMessage = useCallback(
		(entryId: string) => {
			const container = scrollRef.current;
			if (!container) return;

			stopScroll();
			requestAnimationFrame(() => {
				const target = container.querySelector(`[data-message-id="${entryId}"]`);
				if (target) {
					(target as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
				}
			});
		},
		[scrollRef, stopScroll],
	);

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
				setFlashEntryId(entryId);
				if (flashTimer.current) clearTimeout(flashTimer.current);
				flashTimer.current = setTimeout(() => setFlashEntryId(null), 900);
				toast.success(t("chat.branched"), { duration: 1500 });
			} catch (error) {
				toast.dismiss(toastId);
				toast.error(t("chat.navigatingFailed", { message: error instanceof Error ? error.message : "unknown" }));
				appStore.set(navigatingEntryAtomFamily(agentId), null);
			}
		},
		[pendingBranchEntryId, pendingConfirm, inputRef, onSend, agentId, t, scrollToMessage],
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
		(item: TimelineItem) => {
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
			if (item.message || (item.isLive && item.uiBlocks)) {
				const itemEntryId = item.entryId;
				const live = item.isLive && Boolean(item.uiBlocks?.length);
				return (
					<div key={item.id} className="px-msg-item-x py-msg-item-y">
						<div data-message-id={item.id} className="group/message flex flex-col">
							<MessageItem
								message={item.message}
								agentName={agentName}
								isStreaming={live ? isBusy : false}
								autoCollapse={autoCollapse}
								toolExecutions={EMPTY_TOOL_EXECUTIONS}
								toolResultMap={item.toolResultMap}
								isActiveLeaf={Boolean(itemEntryId && itemEntryId === leafId)}
								flash={flashEntryId === item.id}
								liveBlocks={live ? item.uiBlocks : undefined}
								liveToolExecutions={live ? (item.uiTools ?? EMPTY_TOOL_EXECUTIONS) : EMPTY_TOOL_EXECUTIONS}
							/>
							<MessageActions
								show={Boolean(itemEntryId) && Boolean(item.message)}
								isUser={item.message?.role === "user"}
								busy={isBusy || Boolean(navigatingEntry || forkingEntry)}
								onBranch={itemEntryId ? () => handleBranchFromHere(itemEntryId) : undefined}
								onFork={
									item.message && item.message.role !== "user" && itemEntryId
										? () => handleForkToNewChat(itemEntryId)
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
										<span className="ml-auto font-mono text-[10px] text-muted-foreground/60 tabular-nums">
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
			autoCollapse,
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
		],
	);

	const isLoading = sessionState.loadingSnapshot || (!sessionState.snapshotLoaded && sessionState.runtime === null);
	const showLoading = isLoading && timeline.length === 0;

	const isAgentRunning = activeAgentId ? activeUiPhase !== "idle" : false;

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
				) : timeline.length === 0 && !isBusy ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-3 text-center py-8">
						<div className="relative">
							<AiAvatar status={phase} size="lg" />
							<MessageSquare className="absolute -right-2 -bottom-2 size-5 rounded-md border border-hairline bg-background p-1 text-foreground" />
						</div>
						<TimeGreeting />
						<p className="max-w-xs text-xs text-muted-foreground">{t("chat.emptyReassurance")}</p>
					</div>
				) : (
					timeline.map((item) => renderTimelineItem(item))
				)}
			</ConversationContent>
			<ConversationScrollButton className={cn(isAgentRunning && "flowing-border")} />
			<BranchConfirmDialog request={pendingConfirm} onResolve={handleConfirmResolve} />
		</>
	);
});

// ============================================================
// ChatMessageList — 外层
// 负责 timeline 推导 + ready/transitioning 状态 + Conversation 外壳
// ============================================================

const ChatMessageList = memo(function ChatMessageList(props: ChatMessageListProps) {
	const { agentId, sessionState, isBusy } = props;

	// === Timeline ===
	const timeline = useMemo<TimelineItem[]>(
		() =>
			buildTimeline(
				sessionState.entries,
				sessionState.messageDurations,
				sessionState.uiBlocks,
				sessionState.uiTools,
				sessionState.uiPhase,
				sessionState.pendingUserMessage,
				sessionState.runtime?.compactionEstimatedTokensAfter,
			),
		[
			sessionState.entries,
			sessionState.messageDurations,
			sessionState.uiBlocks,
			sessionState.uiTools,
			sessionState.uiPhase,
			sessionState.pendingUserMessage,
			sessionState.runtime?.compactionEstimatedTokensAfter,
		],
	);

	const { leafId } = sessionState;

	// === Anti-flash ready state ===
	const [ready, setReady] = useState(false);
	const prevAgentIdRef = useRef(agentId);

	useEffect(() => {
		if (agentId !== prevAgentIdRef.current) {
			prevAgentIdRef.current = agentId;
			// 目标会话已加载过快照：直接 ready，跳过 opacity 0→1 防闪烁过渡，
			// 快速切换已打开会话时避免闪白/抖动。仅首次加载或冷启动才走防闪烁。
			setReady(sessionState.snapshotLoaded);
		}
	}, [agentId, sessionState.snapshotLoaded]);

	useEffect(() => {
		if (ready) return;

		// 必须等快照加载完毕或 runtime 已创建，否则 sessionState 可能处于中间状态
		// （loadingSnapshot 已完成但 snapshot entries 尚未应用）
		const isLoading = sessionState.loadingSnapshot || (!sessionState.snapshotLoaded && sessionState.runtime === null);
		if (isLoading) return;

		// 关键修复：空消息判断必须确认 snapshot 已加载或 runtime 已就绪，
		// 防止在中间状态（runtime 已创建但 entries 还未应用）时过早 setReady(true)
		const dataReady = sessionState.snapshotLoaded || sessionState.runtime !== null;
		if (timeline.length === 0 && !isBusy && dataReady) {
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
		sessionState.snapshotLoaded,
		sessionState.runtime,
		timeline.length,
		isBusy,
	]);

	return (
		<Conversation key={agentId} className={cn(ready ? "opacity-100" : "opacity-0", "min-h-0 flex-1")}>
			<ChatMessagesInner
				agentId={props.agentId}
				agentName={props.agentName}
				sessionState={sessionState}
				timeline={timeline}
				leafId={leafId}
				autoCollapse={props.autoCollapse}
				phase={props.phase}
				isBusy={isBusy}
				ready={ready}
				transitioning={false}
				inputRef={props.inputRef}
				onSend={props.onSend}
			/>
		</Conversation>
	);
});

export default ChatMessageList;
