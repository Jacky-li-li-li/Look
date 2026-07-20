import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { Button } from "@shared/components/ui/button";
import { cn } from "@shared/lib/utils";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { Check, Copy, GitBranch, Loader2, MessageSquare, Undo2 } from "lucide-react";
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
import { appStore } from "../../store/ipcHandler";
import type { RendererSessionPhase, RendererSessionState } from "../../store/sessionTypes";
import { AiAvatar } from "../AiAvatar";
import {
	BranchConfirmDialog,
	type BranchConfirmRequest,
	type BranchConfirmResult,
} from "../dialogs/BranchConfirmDialog";
import type { ChatInputHandle } from "./ChatInput";
import { Conversation, ConversationContent, ConversationScrollButton, useConversationContext } from "./conversation";
import MessageBubble, { SessionEntryBubble, StreamingMessageBubble } from "./MessageBubble";

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

function fmtUsage(message: AssistantMessage): string {
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

	const renderMessageActions = useCallback(
		(item: TimelineItem, reserveOnly: boolean) => {
			const message = item.message;
			const role = message?.role;
			const supportsActions = role === "assistant" || role === "user";
			if (!reserveOnly && !supportsActions) return null;

			const itemEntryId = item.entryId;
			const showActions = !reserveOnly && supportsActions && Boolean(itemEntryId);
			const actionBusy = isBusy || Boolean(navigatingEntry || forkingEntry);

			return (
				<div
					data-message-actions=""
					data-reserved={showActions ? undefined : ""}
					aria-hidden={!showActions}
					className={cn(
						"mt-msg-action-offset flex min-h-6 items-center gap-msg-action opacity-0 transition-opacity",
						role === "user" ? "self-end mr-msg-action-inset" : "ml-msg-action-inset",
						showActions
							? "group-hover/message:opacity-100 group-focus-within/message:opacity-100"
							: "invisible pointer-events-none",
					)}
				>
					{showActions && itemEntryId && message && (
						<>
							<Button
								variant="ghost"
								size="icon-xs"
								disabled={actionBusy}
								aria-label={t("chat.branchFromHere")}
								onClick={() => handleBranchFromHere(itemEntryId)}
							>
								<Undo2 />
							</Button>
							{message.role !== "user" && (
								<Button
									variant="ghost"
									size="icon-xs"
									disabled={actionBusy}
									aria-label={t("chat.forkToNewChat")}
									onClick={() => handleForkToNewChat(itemEntryId)}
								>
									<GitBranch />
								</Button>
							)}
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={t("chat.copyMessage")}
								onClick={() => handleCopyMessage(item.id, message)}
							>
								{copiedEntryId === item.id ? <Check /> : <Copy />}
							</Button>
							{message.role === "assistant" && (
								<>
									{"model" in message && (
										<span className="ml-1 font-mono text-[10px] text-muted-foreground/60">
											{(message as { model: string }).model}
										</span>
									)}
									{message.usage.totalTokens > 0 && (
										<span className="ml-1 font-mono text-[10px] text-muted-foreground/60">
											{fmtUsage(message)}
										</span>
									)}
									{item.turnDurationMs != null && item.turnDurationMs > 0 && (
										<span className="ml-auto font-mono text-[10px] text-muted-foreground/60 tabular-nums">
											{item.turnDurationMs >= 60_000
												? `${(item.turnDurationMs / 60_000).toFixed(1)}m`
												: `${(item.turnDurationMs / 1_000).toFixed(1)}s`}
										</span>
									)}
								</>
							)}
						</>
					)}
				</div>
			);
		},
		[
			copiedEntryId,
			forkingEntry,
			handleBranchFromHere,
			handleCopyMessage,
			handleForkToNewChat,
			isBusy,
			navigatingEntry,
			t,
		],
	);

	// === Render timeline item ===
	const renderTimelineItem = useCallback(
		(item: TimelineItem) => {
			if (!item) return null;

			if (item.entry) {
				return (
					<div key={item.id} className="px-msg-item-x py-msg-item-y">
						<SessionEntryBubble entry={item.entry} />
					</div>
				);
			}

			if (item.isLive && item.uiBlocks) {
				const itemEntryId = item.entryId;
				if (item.message) {
					return (
						<div key={item.id} className="px-msg-item-x py-msg-item-y">
							<div data-message-id={item.id} className="group/message flex flex-col">
								<MessageBubble
									message={item.message}
									agentName={agentName}
									isStreaming={isBusy}
									autoCollapse={autoCollapse}
									toolExecutions={{} as Record<string, import("@shared/types").LookUiToolExecState>}
									toolResultMap={item.toolResultMap}
									isActiveLeaf={Boolean(itemEntryId && itemEntryId === leafId)}
									liveBlocks={item.uiBlocks}
									liveToolExecutions={
										item.uiTools ?? ({} as Record<string, import("@shared/types").LookUiToolExecState>)
									}
								/>
								{renderMessageActions(item, true)}
							</div>
						</div>
					);
				}
				return (
					<div key={item.id} className="px-msg-item-x py-msg-item-y">
						<div data-message-id={item.id} className="group/message flex flex-col">
							<StreamingMessageBubble
								agentName={agentName}
								blocks={item.uiBlocks}
								toolExecutions={
									item.uiTools ?? ({} as Record<string, import("@shared/types").LookUiToolExecState>)
								}
								isStreaming={isBusy}
								autoCollapse={autoCollapse}
							/>
							{renderMessageActions(item, true)}
						</div>
					</div>
				);
			}

			if (!item.message) return null;

			const itemEntryId = item.entryId;
			return (
				<div key={item.id} className="px-msg-item-x py-msg-item-y">
					<div data-message-id={item.id} className="group/message flex flex-col">
						<MessageBubble
							message={item.message}
							agentName={agentName}
							isStreaming={false}
							autoCollapse={autoCollapse}
							toolExecutions={{} as Record<string, import("@shared/types").LookUiToolExecState>}
							toolResultMap={item.toolResultMap}
							isActiveLeaf={Boolean(itemEntryId && itemEntryId === leafId)}
							flash={flashEntryId === item.id}
						/>
						{renderMessageActions(item, false)}
					</div>
				</div>
			);
		},
		[agentName, autoCollapse, flashEntryId, isBusy, leafId, renderMessageActions],
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
					<div className="flex flex-1 flex-col items-center justify-center gap-4 text-center py-8">
						<div className="relative">
							<AiAvatar status={phase} size="lg" />
							<MessageSquare className="absolute -right-2 -bottom-2 size-5 rounded-md border border-hairline bg-background p-1 text-foreground" />
						</div>
						<h3 className="text-[13px] font-semibold text-foreground">{t("chat.empty")}</h3>
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
			),
		[
			sessionState.entries,
			sessionState.messageDurations,
			sessionState.uiBlocks,
			sessionState.uiTools,
			sessionState.uiPhase,
			sessionState.pendingUserMessage,
		],
	);

	const { leafId } = sessionState;

	// === Anti-flash ready state ===
	const [ready, setReady] = useState(false);
	const prevAgentIdRef = useRef(agentId);

	useEffect(() => {
		if (agentId !== prevAgentIdRef.current) {
			prevAgentIdRef.current = agentId;
			setReady(false);
		}
	}, [agentId]);

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
