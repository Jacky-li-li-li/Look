// ============================================================
// ChatMessageList — Virtual list + Branching + Empty state
// ============================================================

import { Button } from "@shared/components/ui/button";
import { cn } from "@shared/lib/utils";
import type {
	AgentRole,
	AgentStatus,
	PiChunk,
	PiContentBlock,
	PiMessage,
	PiTextBlock,
	PiToolCallBlock,
} from "@shared/types";
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
	sessionLeafIdAtomFamily,
} from "../store/atoms";
import { appStore } from "../store/ipcHandler";
import { BranchConfirmDialog, type BranchConfirmRequest, type BranchConfirmResult } from "./BranchConfirmDialog";
import type { ChatInputHandle } from "./ChatInput";
import MessageBubble from "./MessageBubble";
import { PixelAgentAvatar } from "./PixelAgentAvatar";

interface ChatMessageListProps {
	agentId: string;
	agentRole?: AgentRole;
	agentName?: string;
	messages: PiMessage[];
	autoCollapse: boolean;
	agentStatus: AgentStatus;
	isBusy: boolean;
	inputRef: React.RefObject<ChatInputHandle | null>;
	onSend: (text: string) => void;
}

function fmtTokens(n: number): string {
	if (n === 0) return "";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return `${n}`;
}

function fmtCost(total: number): string {
	if (total === 0) return "";
	return total < 0.01 ? `${total.toFixed(4)}` : `${total.toFixed(2)}`;
}

function fmtUsage(msg: PiMessage): string {
	const u = msg.usage;
	if (!u || u.totalTokens <= 0) return "";
	const parts = [fmtTokens(u.totalTokens)];
	if (u.cost.total > 0) parts.push(fmtCost(u.cost.total));
	return parts.join(" · ");
}

const ChatMessageList = memo(function ChatMessageList({
	agentId,
	agentRole,
	agentName,
	messages,
	autoCollapse,
	agentStatus,
	isBusy,
	inputRef,
	onSend,
}: ChatMessageListProps) {
	const { t } = useTranslation();

	// ---- Message merging logic ----
	const displayMessages = useMemo(() => {
		const merged: PiMessage[] = [];

		function attachToolResult(resultText: string) {
			for (let i = merged.length - 1; i >= 0; i--) {
				const a = merged[i];
				if (a.role !== "assistant") continue;

				if (a.assistantChunks) {
					const chunks = [...a.assistantChunks];
					for (let c = 0; c < chunks.length; c++) {
						const chunk = chunks[c];
						const pendingIdx = chunk.contentBlocks.findIndex(
							(b) => b.type === "toolCall" && !(b as PiToolCallBlock).result,
						);
						if (pendingIdx >= 0) {
							const newBlocks = chunk.contentBlocks.slice();
							const tb = { ...(newBlocks[pendingIdx] as PiToolCallBlock), result: resultText, isError: false };
							newBlocks[pendingIdx] = tb;
							chunks[c] = { contentBlocks: newBlocks };
							merged[i] = { ...a, assistantChunks: chunks };
							return true;
						}
					}
				} else {
					const pendingIdx = a.contentBlocks.findIndex(
						(b) => b.type === "toolCall" && !(b as PiToolCallBlock).result,
					);
					if (pendingIdx >= 0) {
						const newBlocks = a.contentBlocks.slice();
						const tb = { ...(newBlocks[pendingIdx] as PiToolCallBlock), result: resultText, isError: false };
						newBlocks[pendingIdx] = tb;
						merged[i] = { ...a, contentBlocks: newBlocks };
						return true;
					}
				}
			}
			return false;
		}

		for (const msg of messages) {
			if (!msg.contentBlocks) continue;
			if (msg.role === "system") continue;
			if (msg.role === "tool") {
				const resultText = msg.contentBlocks
					.filter((b) => b.type === "text")
					.map((b) => (b as PiTextBlock).text)
					.join("\n");
				if (!resultText) continue;
				attachToolResult(resultText);
				continue;
			}

			const last = merged[merged.length - 1];

			if (last && last.role === "assistant" && msg.role === "assistant") {
				const newBlocks = msg.contentBlocks.map((b) => {
					if (b.type === "toolCall") {
						const t = b as PiToolCallBlock;
						return { ...t, result: t.result ?? "", isError: t.isError ?? false };
					}
					return b;
				});

				const existingChunks: PiChunk[] = last.assistantChunks ?? [{ contentBlocks: last.contentBlocks }];

				existingChunks.push({ contentBlocks: newBlocks });

				const allBlocks: PiContentBlock[] = existingChunks.flatMap((c) => c.contentBlocks);

				merged[merged.length - 1] = {
					...last,
					contentBlocks: allBlocks,
					assistantChunks: existingChunks,
					isStreaming: msg.isStreaming ?? last.isStreaming,
				};
			} else {
				merged.push(msg);
			}
		}

		return merged;
	}, [messages]);

	// ---- v0.4 Session tree / branching ----
	const navigatingEntry = useAtomValue(navigatingEntryAtomFamily(agentId));
	const forkingEntry = useAtomValue(forkingEntryAtomFamily(agentId));
	const sessionLeafId = useAtomValue(sessionLeafIdAtomFamily(agentId));

	const [pendingConfirm, setPendingConfirm] = useState<BranchConfirmRequest | null>(null);
	const [pendingBranchEntryId, setPendingBranchEntryId] = useState<string | null>(null);

	// ── Virtual-scroll + flash (Virtuoso-driven) ──
	const virtuosoRef = useRef<VirtuosoHandle>(null);
	const [isAtBottom, setIsAtBottom] = useState(true);
	const setAtBottomAtom = useSetAtom(activeChatAtBottomAtom);
	useEffect(() => {
		setAtBottomAtom(isAtBottom);
	}, [isAtBottom, setAtBottomAtom]);

	const hasInitialScrolledRef = useRef(false);
	const scrollToBottom = useCallback(() => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				virtuosoRef.current?.scrollToIndex({
					index: "LAST",
					align: "end",
					behavior: "auto",
				});
			});
		});
	}, []);

	useEffect(() => {
		if (!hasInitialScrolledRef.current && displayMessages.length > 0) {
			hasInitialScrolledRef.current = true;
			scrollToBottom();
		}
	}, [displayMessages.length, scrollToBottom]);

	const prevAgentIdRef = useRef(agentId);
	useEffect(() => {
		if (agentId !== prevAgentIdRef.current) {
			prevAgentIdRef.current = agentId;
			scrollToBottom();
		}
	}, [agentId, scrollToBottom]);

	const [flashEntryId, setFlashEntryId] = useState<string | null>(null);
	const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		return () => {
			if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
		};
	}, []);

	const pendingScrollToIndexRef = useRef<number | null>(null);
	const lastCountRef = useRef(displayMessages.length);
	useEffect(() => {
		const targetIdx = pendingScrollToIndexRef.current;
		if (targetIdx == null) return;
		if (targetIdx < displayMessages.length && displayMessages.length !== lastCountRef.current) {
			requestAnimationFrame(() => {
				virtuosoRef.current?.scrollToIndex({
					index: targetIdx,
					align: "center",
					behavior: "smooth",
				});
				pendingScrollToIndexRef.current = null;
			});
			const targetId = displayMessages[targetIdx]?.id;
			if (targetId) {
				setFlashEntryId(targetId);
				if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
				flashTimerRef.current = setTimeout(() => {
					setFlashEntryId(null);
					flashTimerRef.current = null;
				}, 900);
			}
		}
		lastCountRef.current = displayMessages.length;
	}, [displayMessages]);

	// ---- Branching handlers ----

	const handleBranchFromHere = useCallback(
		(entryId: string) => {
			if (isBusy) {
				toast(t("chat.stopFirstToNavigate"));
				return;
			}
			if (navigatingEntry !== null || forkingEntry !== null) return;
			const draftText = inputRef.current?.getText() ?? "";
			if (draftText.trim().length > 0) {
				setPendingBranchEntryId(entryId);
				setPendingConfirm({ kind: "input-not-empty" });
			} else {
				setPendingBranchEntryId(entryId);
				setPendingConfirm({ kind: "summary" });
			}
		},
		[isBusy, navigatingEntry, forkingEntry, inputRef, t],
	);

	const handleForkToNewChat = useCallback(
		async (entryId: string) => {
			if (isBusy) {
				toast(t("chat.stopFirstToNavigate"));
				return;
			}
			if (navigatingEntry !== null || forkingEntry !== null) return;
			const api = (window as any).look;
			if (!api) return;
			appStore.set(forkingEntryAtomFamily(agentId), entryId);
			const toastId = toast.loading(t("chat.forking"));
			try {
				const r = await api.createFork(agentId, entryId, {});
				toast.dismiss(toastId);
				if (!r?.success) {
					toast.error(t("chat.forkFailed", { message: r?.error ?? "unknown" }));
					appStore.set(forkingEntryAtomFamily(agentId), null);
					return;
				}
				if (r.agentId) {
					appStore.set(activeAgentIdAtom, r.agentId);
					toast.success(t("chat.forkCreated"), { duration: 1500 });
				}
			} catch (err: any) {
				toast.dismiss(toastId);
				toast.error(t("chat.forkFailed", { message: err?.message ?? "unknown" }));
				appStore.set(forkingEntryAtomFamily(agentId), null);
			}
		},
		[isBusy, navigatingEntry, forkingEntry, agentId, t],
	);

	const handleConfirmResolve = useCallback(
		async (result: BranchConfirmResult) => {
			const entryId = pendingBranchEntryId;
			const confirm = pendingConfirm;
			setPendingConfirm(null);
			setPendingBranchEntryId(null);
			if (!entryId || !confirm) return;
			if (result.kind === "summary-cancel") return;
			if (confirm.kind === "input-not-empty") {
				if (result.kind === "input-cancel") return;
				if (result.kind === "input-send-first") {
					const draft = inputRef.current?.getText()?.trim() ?? "";
					inputRef.current?.setText("");
					onSend(draft);
					setTimeout(() => {
						setPendingBranchEntryId(entryId);
						setPendingConfirm({ kind: "summary" });
					}, 50);
					return;
				}
			}
			let summarize: boolean;
			if (result.kind === "summary-generate") summarize = true;
			else summarize = false;
			const api = (window as any).look;
			if (!api) return;
			appStore.set(navigatingEntryAtomFamily(agentId), entryId);
			pendingScrollToIndexRef.current = displayMessages.findIndex((m) => m.id === entryId);
			const toastId = toast.loading(t("chat.navigating"));
			try {
				const r = await api.navigateTree(agentId, entryId, { summarize });
				toast.dismiss(toastId);
				if (!r?.success) {
					toast.error(t("chat.navigatingFailed", { message: r?.error ?? "unknown" }));
					appStore.set(navigatingEntryAtomFamily(agentId), null);
					pendingScrollToIndexRef.current = null;
					return;
				}
				const nav = r.result ?? {};
				if (nav.cancelled) {
					appStore.set(navigatingEntryAtomFamily(agentId), null);
					pendingScrollToIndexRef.current = null;
					return;
				}
				if (typeof nav.editorText === "string") {
					inputRef.current?.setText(nav.editorText);
					inputRef.current?.focus();
				} else {
					inputRef.current?.setText("");
					toast(t("chat.switchedToBranchEditorHint"), { duration: 2500 });
				}
				toast.success(t("chat.branched"), { duration: 1500 });
			} catch (err: any) {
				toast.dismiss(toastId);
				toast.error(t("chat.navigatingFailed", { message: err?.message ?? "unknown" }));
				appStore.set(navigatingEntryAtomFamily(agentId), null);
				pendingScrollToIndexRef.current = null;
			}
		},
		[pendingBranchEntryId, pendingConfirm, inputRef, onSend, agentId, t, displayMessages],
	);

	// ---- Copy message ----
	const [copiedEntryId, setCopiedEntryId] = useState<string | null>(null);
	const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		return () => {
			if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
		};
	}, []);
	const handleCopyMessage = useCallback(
		async (entryId: string) => {
			const target = displayMessages.find((m) => m.id === entryId);
			if (!target) return;
			const textBlocks: { type: "text"; text: string }[] = [];
			if (target.assistantChunks && target.assistantChunks.length > 0) {
				for (const chunk of target.assistantChunks) {
					for (const b of chunk.contentBlocks) {
						if (b.type === "text" && b.text) textBlocks.push(b as PiTextBlock);
					}
				}
			} else {
				for (const b of target.contentBlocks) {
					if (b.type === "text" && b.text) textBlocks.push(b as PiTextBlock);
				}
			}
			const text = textBlocks
				.map((b) => b.text)
				.join("\n\n")
				.trim();
			if (!text) return;
			try {
				if (navigator.clipboard?.writeText) {
					await navigator.clipboard.writeText(text);
				} else {
					const ta = document.createElement("textarea");
					ta.value = text;
					ta.style.position = "fixed";
					ta.style.opacity = "0";
					document.body.appendChild(ta);
					ta.select();
					document.execCommand("copy");
					document.body.removeChild(ta);
				}
				setCopiedEntryId(entryId);
				if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
				copyTimerRef.current = setTimeout(() => {
					setCopiedEntryId(null);
					copyTimerRef.current = null;
				}, 1200);
			} catch (err) {
				toast.error(t("chat.copyFailed", { message: (err as Error)?.message ?? "unknown" }));
			}
		},
		[displayMessages, t],
	);

	// ---- Empty state ----
	if (displayMessages.length === 0) {
		return (
			<>
				<div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
					<div className="relative">
						<PixelAgentAvatar role={agentRole} status={agentStatus} size="lg" />
						<MessageSquare className="absolute -right-2 -bottom-2 size-5 rounded-md border border-hairline bg-background p-1 text-foreground" />
					</div>
					<div className="flex flex-col gap-1">
						<h3 className="text-[13px] font-semibold text-foreground">{t("chat.empty")}</h3>
						<p className="text-[11px] text-muted-foreground">Start with a direct task for this agent.</p>
					</div>
					<div className="flex flex-wrap justify-center gap-2 max-w-sm">
						{[
							{ label: "Explain this code", text: "Explain what this code does:" },
							{ label: "Write a function", text: "Write a function that" },
							{ label: "Debug an error", text: "I'm getting this error: " },
						].map((suggestion) => (
							<button
								key={suggestion.label}
								type="button"
								onClick={() => onSend(suggestion.text)}
								className="rounded-full border border-hairline px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							>
								{suggestion.label}
							</button>
						))}
					</div>
				</div>
				<BranchConfirmDialog request={pendingConfirm} onResolve={handleConfirmResolve} />
			</>
		);
	}

	// ---- Normal: message list ----
	return (
		<>
			<div className="h-0 min-h-0 flex-1 relative">
				<Virtuoso
					key={agentId}
					ref={virtuosoRef}
					style={{ height: "100%" }}
					totalCount={displayMessages.length}
					followOutput="smooth"
					atBottomStateChange={setIsAtBottom}
					itemContent={(index) => {
						const msg = displayMessages[index];
						if (!msg) return null;
						const showActions = msg.role === "assistant" || msg.role === "user";
						const isActionBusy = isBusy || navigatingEntry !== null || forkingEntry !== null;
						const actionDisabledReason = isActionBusy ? t("chat.stopFirstToNavigate") : undefined;
						return (
							<div className="px-5 py-2.5">
								<div
									data-message-id={msg.id}
									className={cn(
										"group/message flex flex-col",
										showActions ? "gap-1" : "gap-0",
										msg.isStreaming && "animate-draw-in",
									)}
								>
									<MessageBubble
										message={msg}
										agentRole={agentRole}
										agentName={agentName}
										autoCollapse={autoCollapse}
										isActiveLeaf={!!sessionLeafId && msg.id === sessionLeafId}
										flash={flashEntryId === msg.id}
									/>
									{showActions ? (
										<div
											className={cn(
												"flex items-center gap-1 opacity-0 transition-opacity duration-200 group-hover/message:opacity-100",
												msg.role === "user"
													? "self-end justify-end mr-10 max-w-[80%]"
													: "ml-10 mr-4 max-w-[92%]",
											)}
										>
											<Button
												variant="ghost"
												size="icon-xs"
												disabled={isActionBusy}
												onClick={() => handleBranchFromHere(msg.id)}
												title={actionDisabledReason || t("chat.branchFromHere")}
												aria-label={t("chat.branchFromHere")}
											>
												<Undo2 className="size-3.5" />
											</Button>
											{msg.role === "user" && (
												<Button
													variant="ghost"
													size="icon-xs"
													disabled={isActionBusy}
													onClick={() => handleForkToNewChat(msg.id)}
													title={actionDisabledReason || t("chat.forkToNewChat")}
													aria-label={t("chat.forkToNewChat")}
												>
													<GitBranch className="size-3.5" />
												</Button>
											)}
											{msg.role === "assistant" && (
												<Button
													variant="ghost"
													size="icon-xs"
													onClick={() => handleCopyMessage(msg.id)}
													title={t("chat.copyMessage")}
													aria-label={t("chat.copyMessage")}
												>
													{copiedEntryId === msg.id ? (
														<Check className="size-3.5" />
													) : (
														<Copy className="size-3.5" />
													)}
												</Button>
											)}
											{msg.role === "assistant" && msg.usage && msg.usage.totalTokens > 0 && (
												<span className="ml-2 font-mono text-[10px] text-muted-foreground/60 tabular-nums shrink-0">
													{fmtUsage(msg)}
												</span>
											)}
										</div>
									) : null}
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

/**
 * Floating scroll-to-bottom affordance.
 */
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
			const completed = appStore.get(recentlyCompletedAtom);
			if (completed.includes(activeAgentId)) {
				appStore.set(
					recentlyCompletedAtom,
					completed.filter((id: string) => id !== activeAgentId),
				);
			}
		}
	}, [isAtBottom, activeAgentId]);

	if (isAtBottom) return null;

	return (
		<button
			type="button"
			onClick={() => {
				requestAnimationFrame(() => {
					virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "smooth" });
				});
			}}
			aria-label="Scroll to bottom"
			title="Scroll to bottom"
			className={cn(
				"absolute bottom-4 right-4 z-10 flex size-8 items-center justify-center rounded-full transition-all duration-300 ease-out",
				"scale-100 opacity-100 bg-card shadow-md backdrop-blur-sm",
				isAgentRunning && "flowing-border",
			)}
		>
			<ChevronDown className="size-4 text-muted-foreground transition-all duration-300 ease-out" />
		</button>
	);
}

export default ChatMessageList;
