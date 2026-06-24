import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { Button } from "@shared/components/ui/button";
import { cn } from "@shared/lib/utils";
import type { SessionEntry } from "@shared/types";
import { useAtomValue, useSetAtom } from "jotai";
import { Check, ChevronDown, Copy, GitBranch, MessageSquare, Undo2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { toast } from "sonner";
import {
	activeAgentIdAtom,
	activeChatAtBottomAtom,
	forkingEntryAtomFamily,
	navigatingEntryAtomFamily,
	recentlyCompletedAtom,
	runningAgentsAtom,
} from "../store/atoms";
import { appStore } from "../store/ipcHandler";
import type { RendererSessionPhase, RendererSessionState } from "../store/sessionTypes";
import { BranchConfirmDialog, type BranchConfirmRequest, type BranchConfirmResult } from "./BranchConfirmDialog";
import type { ChatInputHandle } from "./ChatInput";
import MessageBubble, { SessionEntryBubble } from "./MessageBubble";
import { PixelAgentAvatar } from "./PixelAgentAvatar";

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

interface TimelineItem {
	id: string;
	entryId?: string;
	message?: AgentMessage;
	entry?: Exclude<SessionEntry, { type: "message" }>;
	isLive: boolean;
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

const ChatMessageList = memo(function ChatMessageList({
	agentId,
	agentName,
	sessionState,
	autoCollapse,
	phase,
	isBusy,
	inputRef,
	onSend,
}: ChatMessageListProps) {
	const { t } = useTranslation();
	const timeline = useMemo<TimelineItem[]>(() => {
		const persisted = sessionState.entries.flatMap<TimelineItem>((entry) => {
			if (entry.type === "message")
				return [{ id: entry.id, entryId: entry.id, message: entry.message, isLive: false }];
			if (entry.type === "custom_message" && !entry.display) return [];
			return [{ id: entry.id, entryId: entry.id, entry, isLive: false }];
		});
		const live = sessionState.liveMessages.map<TimelineItem>((item) => ({
			id: item.renderId,
			message: item.message,
			isLive: true,
		}));
		return [...persisted, ...live];
	}, [sessionState.entries, sessionState.liveMessages]);

	const navigatingEntry = useAtomValue(navigatingEntryAtomFamily(agentId));
	const forkingEntry = useAtomValue(forkingEntryAtomFamily(agentId));
	const [pendingConfirm, setPendingConfirm] = useState<BranchConfirmRequest | null>(null);
	const [pendingBranchEntryId, setPendingBranchEntryId] = useState<string | null>(null);
	const virtuosoRef = useRef<VirtuosoHandle>(null);
	const [isAtBottom, setIsAtBottom] = useState(true);
	const setAtBottomAtom = useSetAtom(activeChatAtBottomAtom);
	useEffect(() => setAtBottomAtom(isAtBottom), [isAtBottom, setAtBottomAtom]);

	const scrollToBottom = useCallback(() => {
		requestAnimationFrame(() =>
			virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" }),
		);
	}, []);
	const initialScroll = useRef(false);
	useEffect(() => {
		if (!initialScroll.current && timeline.length > 0) {
			initialScroll.current = true;
			scrollToBottom();
		}
	}, [timeline.length, scrollToBottom]);
	useEffect(() => {
		void agentId;
		initialScroll.current = false;
		scrollToBottom();
	}, [agentId, scrollToBottom]);

	const [flashEntryId, setFlashEntryId] = useState<string | null>(null);
	const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (flashTimer.current) clearTimeout(flashTimer.current);
		},
		[],
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
			} catch (error: any) {
				toast.dismiss(toastId);
				toast.error(t("chat.forkFailed", { message: error?.message ?? "unknown" }));
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
				const targetIndex = timeline.findIndex((item) => item.id === entryId);
				if (targetIndex >= 0)
					virtuosoRef.current?.scrollToIndex({ index: targetIndex, align: "center", behavior: "smooth" });
				setFlashEntryId(entryId);
				if (flashTimer.current) clearTimeout(flashTimer.current);
				flashTimer.current = setTimeout(() => setFlashEntryId(null), 900);
				toast.success(t("chat.branched"), { duration: 1500 });
			} catch (error: any) {
				toast.dismiss(toastId);
				toast.error(t("chat.navigatingFailed", { message: error?.message ?? "unknown" }));
				appStore.set(navigatingEntryAtomFamily(agentId), null);
			}
		},
		[pendingBranchEntryId, pendingConfirm, inputRef, onSend, agentId, t, timeline],
	);

	const [copiedEntryId, setCopiedEntryId] = useState<string | null>(null);
	const handleCopyMessage = useCallback(
		async (id: string, message: AgentMessage) => {
			const text = messageText(message);
			if (!text) return;
			try {
				await navigator.clipboard.writeText(text);
				setCopiedEntryId(id);
				setTimeout(() => setCopiedEntryId(null), 1200);
			} catch (error: any) {
				toast.error(t("chat.copyFailed", { message: error?.message ?? "unknown" }));
			}
		},
		[t],
	);

	if (timeline.length === 0) {
		return (
			<>
				<div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
					<div className="relative">
						<PixelAgentAvatar status={phase} size="lg" />
						<MessageSquare className="absolute -right-2 -bottom-2 size-5 rounded-md border border-hairline bg-background p-1 text-foreground" />
					</div>
					<h3 className="text-[13px] font-semibold text-foreground">{t("chat.empty")}</h3>
				</div>
				<BranchConfirmDialog request={pendingConfirm} onResolve={handleConfirmResolve} />
			</>
		);
	}

	return (
		<>
			<div className="relative h-0 min-h-0 flex-1">
				<Virtuoso
					key={agentId}
					ref={virtuosoRef}
					style={{ height: "100%" }}
					totalCount={timeline.length}
					followOutput="smooth"
					atBottomStateChange={setIsAtBottom}
					itemContent={(index) => {
						const item = timeline[index];
						if (!item) return null;
						if (item.entry) {
							return (
								<div className="px-5 py-2.5">
									<SessionEntryBubble entry={item.entry} />
								</div>
							);
						}
						if (!item.message) return null;
						const entryId = item.entryId;
						const showActions = Boolean(
							entryId && (item.message.role === "assistant" || item.message.role === "user"),
						);
						const actionBusy = isBusy || Boolean(navigatingEntry || forkingEntry);
						return (
							<div className="px-5 py-2.5">
								<div
									data-message-id={item.id}
									className={cn(
										"group/message flex flex-col",
										showActions && "gap-1",
										item.isLive && "animate-draw-in",
									)}
								>
									<MessageBubble
										message={item.message}
										agentName={agentName}
										isStreaming={
											item.isLive &&
											!sessionState.liveMessages.find((live) => live.renderId === item.id)?.completed
										}
										autoCollapse={autoCollapse}
										toolExecutions={sessionState.toolExecutions}
										isActiveLeaf={Boolean(entryId && entryId === sessionState.leafId)}
										flash={flashEntryId === item.id}
									/>
									{showActions && entryId && (
										<div
											className={cn(
												"flex items-center gap-1 opacity-0 transition-opacity group-hover/message:opacity-100",
												item.message.role === "user" ? "self-end mr-10" : "ml-10",
											)}
										>
											<Button
												variant="ghost"
												size="icon-xs"
												disabled={actionBusy}
												onClick={() => handleBranchFromHere(entryId)}
											>
												<Undo2 className="size-3.5" />
											</Button>
											{item.message.role !== "user" && (
												<Button
													variant="ghost"
													size="icon-xs"
													disabled={actionBusy}
													onClick={() => handleForkToNewChat(entryId)}
												>
													<GitBranch className="size-3.5" />
												</Button>
											)}
											{item.message.role === "assistant" && (
												<>
													<Button
														variant="ghost"
														size="icon-xs"
														onClick={() => handleCopyMessage(item.id, item.message!)}
													>
														{copiedEntryId === item.id ? (
															<Check className="size-3.5" />
														) : (
															<Copy className="size-3.5" />
														)}
													</Button>
													{item.message.usage.totalTokens > 0 && (
														<span className="ml-2 font-mono text-[10px] text-muted-foreground/60">
															{fmtUsage(item.message)}
														</span>
													)}
												</>
											)}
										</div>
									)}
								</div>
							</div>
						);
					}}
				/>
				<ScrollToBottomButton isAtBottom={isAtBottom} virtuosoRef={virtuosoRef} />
			</div>
			<BranchConfirmDialog request={pendingConfirm} onResolve={handleConfirmResolve} />
		</>
	);
});

interface ScrollToBottomButtonProps {
	isAtBottom: boolean;
	virtuosoRef: React.RefObject<VirtuosoHandle | null>;
}

export function ScrollToBottomButton({ isAtBottom, virtuosoRef }: ScrollToBottomButtonProps) {
	const activeAgentId = useAtomValue(activeAgentIdAtom);
	const runningAgents = useAtomValue(runningAgentsAtom);
	const isAgentRunning = activeAgentId ? runningAgents.has(activeAgentId) : false;
	const wasAtBottomRef = useRef(isAtBottom);
	useEffect(() => {
		const justLandedAtBottom = isAtBottom && !wasAtBottomRef.current;
		wasAtBottomRef.current = isAtBottom;
		if (justLandedAtBottom && activeAgentId) {
			appStore.set(
				recentlyCompletedAtom,
				appStore.get(recentlyCompletedAtom).filter((id) => id !== activeAgentId),
			);
		}
	}, [isAtBottom, activeAgentId]);
	if (isAtBottom) return null;
	return (
		<button
			type="button"
			onClick={() =>
				requestAnimationFrame(() =>
					virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "smooth" }),
				)
			}
			aria-label="Scroll to bottom"
			className={cn(
				"absolute right-4 bottom-4 z-10 flex size-8 items-center justify-center rounded-full bg-card shadow-md",
				isAgentRunning && "flowing-border",
			)}
		>
			<ChevronDown className="size-4 text-muted-foreground" />
		</button>
	);
}

export default ChatMessageList;
