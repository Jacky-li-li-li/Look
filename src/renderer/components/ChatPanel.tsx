// ============================================================
// ChatPanel — Whisper Bubbles + Line Input (Ink Wash, shadcn/ui)
// ============================================================

import { Button } from "@shared/components/ui/button";
import { Textarea } from "@shared/components/ui/textarea";
import { cn } from "@shared/lib/utils";
import type {
	AgentRole,
	AgentStatus,
	PermissionMode,
	PiChunk,
	PiContentBlock,
	PiMessage,
	PiTextBlock,
	PiToolCallBlock,
} from "@shared/types";
import { useAtomValue, useSetAtom } from "jotai";
import {
	GitBranch,
	Check,
	ChevronDown,
	Copy,
	GitFork,
	Undo2,
	MessageSquare,
	Send,
	Square,
} from "lucide-react";
import type React from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import {
	activeAgentIdAtom,
	activeChatAtBottomAtom,
	forkingEntryAtomFamily,
	navigatingEntryAtomFamily,
	recentlyCompletedAtom,
	sessionLeafIdAtomFamily,
} from "../store/atoms";
import { appStore } from "../store/ipcHandler";
import { BranchConfirmDialog, type BranchConfirmRequest, type BranchConfirmResult } from "./BranchConfirmDialog";
import ContextRing from "./ContextRing";
import MessageBubble from "./MessageBubble";
import ModelSelector from "./ModelSelector";
import { PermissionModeSelector } from "./PermissionModeSelector";
import { PixelAgentAvatar } from "./PixelAgentAvatar";
import SkillOverlaySegments from "./SkillOverlaySegments";
import { type CommonSkillPath, handleSlashMenuKey, type SkillEntry, SkillSlashMenu } from "./SkillSlashMenu";
import ThinkingSelector from "./ThinkingSelector";

interface ChatPanelProps {
	agentId: string;
	agentRole?: AgentRole;
	agentName?: string;
	messages: PiMessage[];
	autoCollapse: boolean;
	/**
	 * SDK-authoritative queue snapshot for this agent. Driven by
	 * `agent:queue_update` events from the main process (which
	 * mirrors pi SDK's internal _steeringMessages /
	 * _followUpMessages). The drawer's depth comes from
	 * `steering.length + followUp.length`, and the same number of
	 * most-recent user messages is hidden from the main stream
	 * (they show in the drawer instead).
	 */
	queue: { steering: string[]; followUp: string[] };
	agentStatus: AgentStatus;
	currentModel: string;
	currentThinking: string;
	currentPermissionMode: PermissionMode;
	onSend: (text: string) => void;
	onThinkingChange: (level: string) => void;
	onModelChange: (model: string) => void;
	onPermissionModeChange: (mode: PermissionMode) => void;
	/** Fired when an empty ModelSelector CTA asks to open API key settings. */
	onRequestApiKeys?: () => void;
	/** Fired when the user clicks the Stop button (visible while the
	 * agent is busy). Maps to `agent:abort` IPC; safe to call when
	 * not streaming (no-op on the main-process side).
	 */
	onAbort?: () => void;
}
const ChatPanel = memo(function ChatPanel({
	agentId,
	agentRole,
	agentName,
	messages,
	autoCollapse,
	queue,
	agentStatus,
	currentModel,
	currentThinking,
	currentPermissionMode,
	onSend,
	onThinkingChange,
	onModelChange,
	onPermissionModeChange,
	onRequestApiKeys,
	onAbort,
}: ChatPanelProps) {
	const { t } = useTranslation();
	const [input, setInput] = useState("");
	const inputRef = useRef<HTMLTextAreaElement>(null);

	// ---- v0.3 skills: lazy-load + slash menu state ----
	// We fetch the skill list once per agent mount. The main process
	// caches by projectRoot + invalidates on FS change, so re-fetching
	// in dev hot-reload is fine and cheap.
	const [skills, setSkills] = useState<SkillEntry[]>([]);
	const [importedPaths, setImportedPaths] = useState<string[]>([]);
	const [detected, setDetected] = useState<CommonSkillPath[]>([]);
	const [slashIndex, setSlashIndex] = useState(0);
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const [list, det] = await Promise.all([window.look.listSkills(), window.look.detectCommonSkillPaths()]);
				if (cancelled) return;
				if (list.success) {
					setSkills(list.skills ?? []);
					setImportedPaths(list.importedPaths ?? []);
				}
				if (det.success) {
					setDetected(det.detected ?? []);
				}
			} catch {
				// Non-fatal: the slash menu just won't have data.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);
	// Slash menu visibility — true when the input looks like `/xxx`
	// without any whitespace (so mid-sentence `/` doesn't trigger).
	const slashOpen = useMemo(() => /^\/[^\s]*$/.test(input), [input]);
	// Reset index whenever the menu re-opens.
	useEffect(() => {
		if (slashOpen) setSlashIndex(0);
	}, [slashOpen]);
	// Compute pickable count so handleSlashMenuKey can wrap-around.
	const visibleSkills = useMemo(() => skills.filter((s) => !s.disableModelInvocation), [skills]);
	// Extract the search term after `/` for skill filtering.
	const slashSearchTerm = useMemo(() => {
		const m = input.match(/^\/(.+)$/);
		return m ? m[1] : "";
	}, [input]);
	// Filter skills by search term (case-insensitive match on name + description).
	const filteredSkills = useMemo(() => {
		if (!slashSearchTerm) return visibleSkills;
		const term = slashSearchTerm.toLowerCase();
		return visibleSkills.filter(
			(s) => s.name.toLowerCase().includes(term) || s.description.toLowerCase().includes(term),
		);
	}, [visibleSkills, slashSearchTerm]);
	const importableDetected = useMemo(
		() => detected.filter((d) => d.exists && !importedPaths.includes(d.path)),
		[detected, importedPaths],
	);
	const pickableCount = filteredSkills.length + importableDetected.length;
	// Commit a chosen skill name into the input.
	const importDetected = useCallback(async (d: CommonSkillPath) => {
		const res = await window.look.importSkillPaths([d.path]);
		if (res.success) {
			// Refetch skills + detection to reflect the new path.
			const [list, det] = await Promise.all([window.look.listSkills(), window.look.detectCommonSkillPaths()]);
			if (list.success) {
				setSkills(list.skills ?? []);
				setImportedPaths(list.importedPaths ?? []);
			}
			if (det.success) setDetected(det.detected ?? []);
		}
	}, []);
	const commitSlashSelection = useCallback(
		(index: number) => {
			if (index < filteredSkills.length) {
				const s = filteredSkills[index];
				if (s) setInput(`/skill:${s.name} `);
			} else {
				const i = index - filteredSkills.length;
				const d = importableDetected[i];
				if (d) void importDetected(d);
			}
		},
		[filteredSkills, importableDetected, importDetected],
	);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	// ---- Queue drawer: depth comes from the SDK's own queue ----
	// We no longer maintain a renderer-side fake queue. The `queue`
	// prop is driven by `agent:queue_update` events forwarded from
	// pi's _emitQueueUpdate(); the SDK itself decides when items
	// are added (prompt-with-streaming, steer, followUp) and removed
	// (user message_start, clearQueue). Survives agent switches,
	// app restarts, and aborts without any local bookkeeping.
	const isBusy = agentStatus === "thinking" || agentStatus === "working";

	const handleAbort = () => {
		// The drawer empties in lockstep with the SDK's clearQueue()
		// (called by the main process on abort), which emits a fresh
		// agent:queue_update event. We do NOT locally clear the queue
		// here — that would race with the SDK's authoritative state.
		onAbort?.();
	};

	const displayMessages = useMemo(() => {
		const merged: PiMessage[] = [];

		/** Attach a tool result to the FIFO-pending toolCall in the last assistant.
		 *  Searches backwards through merged[], then **forward** through chunks
		 *  (oldest chunk first) so the pending toolCall from the earliest-assigned
		 *  tool block gets its result first — matching the SDK's emit order. */
		function attachToolResult(resultText: string) {
			for (let i = merged.length - 1; i >= 0; i--) {
				const a = merged[i];
				if (a.role !== "assistant") continue;

				const chunks = a.assistantChunks;
				if (chunks) {
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
							merged[i] = { ...a, assistantChunks: chunks.slice() };
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
			// Skip internal system messages (agent startup info) — they're
			// only meaningful to the agent's context, not the user.
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
				// Consecutive assistant → push as a new CHUNK
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
		// chat is the source of truth for the user — every message they
		// sent (and the assistant replies, tool calls, etc) lives here.
		// The SDK's `agent:queue_update` event projects the in-flight
		// `steerQueue` / `followUpQueue` *as preview strings* for the
		// drawer only. When the SDK drains a queued message, it emits
		// `message_start` + `message_end` with the real `AgentMessage` —
		// so the chat transcript already shows the user message by the
		// time the drawer empties.
		//
		// The previous implementation tried to *hide* the last N chat
		// rows whenever the queue depth was N, on the assumption that
		// "the drawer shows them". That was a category error:
		//   • The drawer shows *pending* text the user has typed but
		//     the SDK hasn't yet emitted a `message_start` for.
		//   • The chat shows *emitted* `AgentMessage` objects.
		//   • Hiding the chat row for "drawer depth" N also hides
		//     *historical* user messages whenever the queue ever
		//     reaches depth N (which it does whenever the user clicks
		//     send while the agent is busy). That's the visual glitch
		//     the original fix here was masking.
		//
		// The right behavior is: chat is the authoritative transcript
		// (don't touch it), drawer is a separate preview pane (the
		// `queue.steering.length + queue.followUp.length` already drives
		// its height/visibility at the JSX site below). The two
		// windows are visually adjacent but render fully independently.

		return merged;
	}, [messages]);

	const handleSend = () => {
		const text = input.trim();
		if (!text) return;
		// We do NOT maintain a renderer-side fake queue. If the
		// agent is busy, the main process routes this prompt to
		// session.prompt({ streamingBehavior: "steer" }) which
		// appends to pi's _steeringMessages and emits a fresh
		// agent:queue_update — the drawer syncs off that event.
		onSend(text);
		setInput("");
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		// v0.3 skills: let the slash menu handle ↑↓ Enter Esc first
		// when it's open. `handleSlashMenuKey` returns true when it
		// consumed the event.
		if (
			slashOpen &&
			handleSlashMenuKey(e, { open: true, selectedIndex: slashIndex, pickableCount }, (next) => {
				setSlashIndex(next.selectedIndex);
				if (!next.open) {
					// Esc — clear the slash token.
					setInput("");
				}
			})
		) {
			if (e.key === "Enter" || e.key === "Tab") {
				commitSlashSelection(slashIndex);
			}
			return;
		}
		if (e.key === "Enter" && !e.shiftKey && !(e.nativeEvent as KeyboardEvent).isComposing) {
			e.preventDefault();
			handleSend();
		}
	};

	// ---- v0.4 Session tree / branching ----
	// Read the per-agent tree/leaf state from Jotai (driven by
	// `agent:tree-changed` events in store/ipcHandler.ts). The
	// `isActiveLeaf` derived on the spot is cheap — `Set.has` is
	// O(1) and the set only has at most a few entries.
	const navigatingEntry = useAtomValue(navigatingEntryAtomFamily(agentId));
	const forkingEntry = useAtomValue(forkingEntryAtomFamily(agentId));
	const sessionLeafId = useAtomValue(sessionLeafIdAtomFamily(agentId));

	// Confirm-sheet state. `pendingBranchEntryId` is the assistant
	// bubble the user clicked; `pendingConfirm` is the dialog
	// content. We hold the entry separately so the dialog can
	// reference it after the user picks a summary option without
	// the closure capturing stale data.
	const [pendingConfirm, setPendingConfirm] = useState<BranchConfirmRequest | null>(null);
	const [pendingBranchEntryId, setPendingBranchEntryId] = useState<string | null>(null);
	// True while a fork is in flight (post-confirm) so the action
	// strip on the bubble can flip to a disabled state until the
	// agent:tree-changed event lands.

	// Ref that records "I just asked the main process to navigate
	// to entry X — when the message list updates, scroll the
	// matching DOM node into view and flash it". Cleared after
	// the scroll runs (one-shot) so streaming messages don't keep
	// yanking the view.
	const pendingScrollToRef = useRef<string | null>(null);
	// Entry id that should receive the bubble-flash animation
	// right now. Set by the scroll-into-view effect after a
	// navigate, cleared ~900ms later. State-driven (not classList
	// imperative) so React owns the class application.
	const [flashEntryId, setFlashEntryId] = useState<string | null>(null);
	const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		return () => {
			if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
		};
	}, []);

	// One-shot scroll + flash after the message list updates to
	// reflect a navigate. We trigger on the *first* render where
	// the pending entry's message is present and a previous
	// ref-snapshot of the messages did not contain it. The library
	// does a smooth scroll on its own, but the entry might be far
	// up the list, so we override with explicit scrollIntoView.
	// The flash is then driven by `flashEntryId` state — MessageBubble
	// adds .bubble-flash when its id matches — so React owns the
	// class lifecycle, not us.
	const lastMessageIdsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const target = pendingScrollToRef.current;
		if (!target) return;
		const ids = new Set(displayMessages.map((m) => m.id));
		if (ids.has(target) && !lastMessageIdsRef.current.has(target)) {
			requestAnimationFrame(() => {
				const el = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(target)}"]`);
				if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
				pendingScrollToRef.current = null;
			});
			setFlashEntryId(target);
			if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
			flashTimerRef.current = setTimeout(() => {
				setFlashEntryId(null);
				flashTimerRef.current = null;
			}, 900);
		}
		lastMessageIdsRef.current = ids;
	}, [displayMessages]);

	const handleBranchFromHere = useCallback(
		(entryId: string) => {
			// Block if the agent is busy generating — main process
			// would throw, and we want a friendlier surface here.
			if (isBusy) {
				toast(t("chat.stopFirstToNavigate"));
				return;
			}
			// Block re-entry if another navigate is in flight.
			if (navigatingEntry !== null || forkingEntry !== null) return;
			// Two-step confirm: if the user has un-sent text, ask
			// whether to send it first (otherwise we'd silently
			// discard their draft on the upcoming leaf switch).
			if (input.trim().length > 0) {
				setPendingBranchEntryId(entryId);
				setPendingConfirm({ kind: "input-not-empty" });
			} else {
				setPendingBranchEntryId(entryId);
				setPendingConfirm({ kind: "summary" });
			}
		},
		[isBusy, navigatingEntry, forkingEntry, input, t],
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
				// Switch the active agent to the new one so the
				// user lands on their forked session.
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

	// Resolve the confirm sheet into an actual action. Single
	// dispatcher so the dialog stays dumb about what each kind means.
	const handleConfirmResolve = useCallback(
		async (result: BranchConfirmResult) => {
			const entryId = pendingBranchEntryId;
			const confirm = pendingConfirm;
			setPendingConfirm(null);
			setPendingBranchEntryId(null);
			if (!entryId || !confirm) return;
			// User dismissed the dialog via X / Escape — bail without navigating.
			if (result.kind === "summary-cancel") return;
			if (confirm.kind === "input-not-empty") {
				if (result.kind === "input-cancel") return;
				if (result.kind === "input-send-first") {
					// Send the user's draft, then proceed to the
					// summary prompt. The user gets a normal message
					// flow first; the navigate is the second step.
					const draft = input.trim();
					setInput("");
					onSend(draft);
					// Defer the summary prompt until the SDK has
					// actually accepted the message (one tick is
					// enough — handleSessionEvent updates leaf on
					// message_start).
					setTimeout(() => {
						setPendingBranchEntryId(entryId);
						setPendingConfirm({ kind: "summary" });
					}, 50);
					return;
				}
				// result.kind === "input-overwrite" → fall through
				// to the summary prompt, replacing the input box
				// with the editorText returned by navigateTree.
			}
			// From here on we're definitely about to call
			// navigateTree. Decide the summary options first.
			let summarize: boolean;
			if (result.kind === "summary-generate") summarize = true;
			else summarize = false;
			const api = (window as any).look;
			if (!api) return;
			appStore.set(navigatingEntryAtomFamily(agentId), entryId);
			pendingScrollToRef.current = entryId;
			const toastId = toast.loading(t("chat.navigating"));
			try {
				const r = await api.navigateTree(agentId, entryId, { summarize });
				toast.dismiss(toastId);
				if (!r?.success) {
					toast.error(t("chat.navigatingFailed", { message: r?.error ?? "unknown" }));
					appStore.set(navigatingEntryAtomFamily(agentId), null);
					pendingScrollToRef.current = null;
					return;
				}
				const nav = r.result ?? {};
				if (nav.cancelled) {
					// User bailed at the summary prompt inside the
					// SDK (it can show its own chooser). The main
					// process keeps the previous leaf.
					appStore.set(navigatingEntryAtomFamily(agentId), null);
					pendingScrollToRef.current = null;
					return;
				}
				// Put the returned editorText in the input box. If
				// undefined (target was not a user message), clear
				// it and surface a hint.
				if (typeof nav.editorText === "string") {
					setInput(nav.editorText);
					inputRef.current?.focus();
				} else {
					setInput("");
					toast(t("chat.switchedToBranchEditorHint"), { duration: 2500 });
				}
				toast.success(t("chat.branched"), { duration: 1500 });
				// The agent:tree-changed event will clear the
				// navigating flag and update leafId.
			} catch (err: any) {
				toast.dismiss(toastId);
				toast.error(t("chat.navigatingFailed", { message: err?.message ?? "unknown" }));
				appStore.set(navigatingEntryAtomFamily(agentId), null);
				pendingScrollToRef.current = null;
			}
		},
		[pendingBranchEntryId, pendingConfirm, input, onSend, agentId, t],
	);

	// v0.4 — "Copy message" handler. Extracts the plain-text
	// content from the assistant message (skipping thinking /
	// toolCall blocks) and writes it to the system clipboard.
	// Shows a brief "Copied" toast and flips the button icon
	// to a check mark for ~1.2s so the action has a visible
	// affordance even on a quick click.
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
			// Compose plain text from text blocks. For multi-chunk
			// assistant messages, `assistantChunks` is the
			// authoritative source — `contentBlocks` may have
			// been flattened to a single merged block already by
			// the renderer, in which case the chunks are still
			// available for copy.
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
				// navigator.clipboard is available in the Electron
				// renderer; falls back to the legacy execCommand path
				// for older sandboxes.
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

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{" "}
			{displayMessages.length === 0 ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
					<div className="relative">
						<PixelAgentAvatar role={agentRole} status={agentStatus} size="lg" />
						<MessageSquare className="absolute -right-2 -bottom-2 size-5 rounded-md border border-hairline bg-background p-1 text-foreground" />
					</div>
					<div className="flex flex-col gap-1">
						<h3 className="text-[13px] font-semibold text-foreground">{t("chat.empty")}</h3>
						<p className="text-[11px] text-muted-foreground">Start with a direct task for this agent.</p>
					</div>
				</div>
			) : (
				<StickToBottom
					key={agentId}
					initial="instant"
					resize="smooth"
					// h-0 + flex-1 is the standard Tailwind flex-column pattern:
					// the inner <StickToBottom.Content> is styled with
					// `height: 100%` by the library, and that percentage only
					// resolves to a real pixel value when the parent has an
					// *explicit* height (flex-1 alone isn't enough — the
					// browser computes it but treats the box as indefinite
					// for child percentage resolution). h-0 + flex-1 lets
					// flex grow the box to the available space *and* gives
					// the child a concrete parent height to resolve against.
					// overflow-hidden clips the library's transform-translated
					// content to the box. min-h-0 stops long messages from
					// inflating the flex item past its allocation.
					className="relative h-0 min-h-0 flex-1 overflow-hidden"
				>
					<StickToBottom.Content className="flex flex-col gap-5 px-5 py-2.5">
						{displayMessages.map((msg) => {
							// v0.4 — action strip aligned with pi SDK:
							//  Branch from here (/tree) → any message
							//  Fork to new chat (/fork)  → user messages only (matches getUserMessagesForForking)
							const showActions = msg.role === "assistant" || msg.role === "user";
							const isActionBusy = isBusy || navigatingEntry !== null || forkingEntry !== null;
							const actionDisabledReason = isActionBusy ? t("chat.stopFirstToNavigate") : undefined;
							return (
								<div
									key={msg.id}
									data-message-id={msg.id}
									className={cn("group/message flex flex-col", showActions ? "gap-1" : "gap-0")}
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
												"flex items-center gap-1.5 opacity-0 transition-opacity duration-150 group-hover/message:opacity-100",
												msg.role === "user" ? "mr-9 justify-end" : "ml-9",
											)}
										>
											<Button
												variant="line-ghost"
												size="xs"
												disabled={isActionBusy}
												onClick={() => handleBranchFromHere(msg.id)}
												title={actionDisabledReason}
												aria-label={t("chat.branchFromHere")}
											>
												<Undo2 className="size-3" />

											</Button>
											{msg.role === "user" ? (
												<Button
													variant="line-ghost"
													size="xs"
													disabled={isActionBusy}
													onClick={() => handleForkToNewChat(msg.id)}
													title={actionDisabledReason}
													aria-label={t("chat.forkToNewChat")}
												>
													<GitBranch className="size-3" />

												</Button>
											) : null}
											{msg.role === "assistant" ? (
												<Button
													variant="line-ghost"
													size="xs"
													onClick={() => handleCopyMessage(msg.id)}
													title={t("chat.copyMessage")}
													aria-label={t("chat.copyMessage")}
												>
												{copiedEntryId === msg.id ? (
													<Check className="size-3" />
												) : (
													<Copy className="size-3" />
												)}

											</Button>
											) : null}
										</div>
									) : null}
								</div>
							);
						})}
					</StickToBottom.Content>
					{/* Floating scroll-to-bottom button — appears when the user
					    scrolls up to read history. useStickToBottomContext drives
					    isAtBottom off the user's actual scroll position; the
					    library also handles "escape from lock" so a brand-new
					    streaming message won't yank the user back down once
					    they've intentionally scrolled away. */}
					<ScrollToBottomButton />
				</StickToBottom>
			)}
			{/* Queue drawer — slides up when the SDK's queue is non-empty.
			    The list comes from the `queue` prop (driven by
			    `agent:queue_update` events forwarded from pi's
			    _emitQueueUpdate()), so it survives agent switches, app
			    restarts, and aborts. */}
			<div
				className={cn(
					"shrink-0 overflow-hidden transition-all duration-200 ease-out",
					queue.steering.length + queue.followUp.length > 0 ? "max-h-56 opacity-100" : "max-h-0 opacity-0",
				)}
			>
				<div className="w-full px-5 py-2">
					<div className="mb-1.5 flex items-center gap-2">
						<span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
							{t("chat.queued")}
						</span>
						<span className="text-[10px] tabular-nums text-muted-foreground/40">
							{queue.steering.length + queue.followUp.length}
						</span>
					</div>
					<div className="max-h-40 space-y-1 overflow-y-auto">
						{[...queue.steering, ...queue.followUp].map((text, i) => (
							<div
								key={`q-${i}-${text.slice(0, 16)}`}
								className="flex items-center gap-2 rounded-md border border-hairline bg-card/40 px-2.5 py-1.5 animate-draw-in"
								style={{ animationDelay: `${i * 40}ms` }}
							>
								<span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold tabular-nums text-muted-foreground">
									{i + 1}
								</span>
								<span className="min-w-0 truncate text-[12px] leading-relaxed text-foreground/70">{text}</span>
							</div>
						))}
					</div>
				</div>
			</div>
			<div className="shrink-0 border-t border-hairline bg-background/70 px-5 py-2.5 backdrop-blur-md">
				<div className="relative rounded-lg border border-hairline bg-card/60 shadow-none backdrop-blur-sm">
					{/* v0.3: /skill:name slash menu — absolute-positioned
					    above the textarea. Absolute so it doesn't push
					    the messages area when it opens. */}
					{slashOpen ? (
						<SkillSlashMenu
							skills={filteredSkills}
							searchTerm={slashSearchTerm}
							importedPaths={importedPaths}
							detected={detected}
							selectedIndex={slashIndex}
							onSelectedIndexChange={setSlashIndex}
							onSelectSkill={(s) => setInput(`/skill:${s.name} `)}
							onImportFrom={(d) => void importDetected(d)}
							onImportRequest={() => {
								// Placeholder: a real "custom path" picker
								// could live in Settings. For now, just
								// close the slash token and let the user
								// drop a SKILL.md into ~/.look/skills/.
								setInput("");
							}}
							onClose={() => setInput("")}
						/>
					) : null}
					{/* Active skill highlight overlay — sits *behind* the
					    textarea in z-order so the textarea's own text and
					    selection highlight stay on top. The grid trick
					    (both children pinned to row 1 col 1) makes the
					    overlay and textarea occupy the *same* box, so the
					    overlay's intrinsic height tracks the textarea as
					    it grows. The overlay paints `/skill:foo` runs
					    with an inset box-shadow via .skill-active-highlight
					    (App.css); the textarea's own characters sit on
					    top of that tint (the textarea is `bg-transparent`)
					    and the textarea's selection highlight is
					    unaffected (it renders above any background,
					    including the overlay's).

					    Caret-safety rules (see SkillTag.tsx file header):
					      • text-transparent on the overlay characters
					        (both the bare spans and the SkillTag run)
					        so the textarea's own text is the only thing
					        the user reads
					      • pointer-events-none so focus stays on the
					        textarea
					      • same font, size, line-height, padding, wrap
					        settings as the textarea class
					      • box-shadow (inset) is the only decoration
					        on the skill run; it doesn't widen the box,
					        so caret alignment is preserved. */}
					<div className="grid grid-cols-1 grid-rows-1">
						{!slashOpen && input.length > 0 ? (
							<div
								aria-hidden
								className="pointer-events-none col-start-1 row-start-1 overflow-hidden whitespace-pre-wrap break-words bg-transparent px-3 py-2.5 text-[13px] leading-relaxed text-transparent"
							>
								<SkillOverlaySegments content={input} />
							</div>
						) : null}
						<Textarea
							ref={inputRef}
							value={input}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder={isBusy ? `${t("chat.send")}… (Enter to queue)` : `${t("chat.placeholder")}`}
							rows={2}
							style={{ gridArea: "1 / 1" }}
							className="min-h-16 resize-none rounded-none border-0 bg-transparent px-3 py-2.5 text-[13px] leading-relaxed shadow-none placeholder:text-muted-foreground/50 focus-visible:ring-0 focus-visible:outline-0"
						/>
					</div>
					<div className="flex items-center gap-1.5 border-t border-hairline px-2 py-2">
						<ModelSelector
							agentId={agentId}
							currentModel={currentModel}
							onModelChanged={onModelChange}
							onRequestApiKeys={onRequestApiKeys}
						/>
						<ThinkingSelector agentId={agentId} currentLevel={currentThinking} onChanged={onThinkingChange} />
						<PermissionModeSelector mode={currentPermissionMode} onChange={onPermissionModeChange} />
						<div className="flex-1" />
						<ContextRing />
						{isBusy ? (
							<>
								<Button
									variant="line"
									size="icon-sm"
									onClick={handleAbort}
									aria-label={t("chat.stop")}
									title={t("chat.stop")}
									className="text-muted-foreground hover:text-destructive"
								>
									<Square data-icon="inline-start" className="size-3 fill-current" />
								</Button>
								<Button
									variant={input.trim() ? "line-filled" : "line"}
									size="icon-sm"
									onClick={handleSend}
									disabled={!input.trim()}
									aria-label={t("chat.send")}
								>
									<Send data-icon="inline-start" className="size-3.5" />
								</Button>
							</>
						) : (
							<Button
								variant={input.trim() ? "line-filled" : "line"}
								size="icon-sm"
								onClick={handleSend}
								disabled={!input.trim()}
								aria-label={t("chat.send")}
							>
								<Send data-icon="inline-start" className="size-3.5" />
							</Button>
						)}
					</div>
				</div>
			</div>
			{/* v0.4 — Branch confirm sheet. Two modes (summary,
			    input-not-empty) live in one component so the modal
			    surface is unified. The dialog is dumb about WHAT the
			    result means; ChatPanel translates the result into
			    the corresponding navigate / send / cancel call. */}
			<BranchConfirmDialog request={pendingConfirm} onResolve={handleConfirmResolve} />
		</div>
	);
});

/**
 * Floating scroll-to-bottom affordance.
 *
 * Lives INSIDE <StickToBottom> so it can call useStickToBottomContext.
 * The library auto-hides this when the user is at the bottom and shows
 * it when they scroll up (see StickToBottom's escapedFromLock mechanic).
 *
 * Positioning: absolute bottom-4 right-4, on top of the message area,
 * matching the original Virtuoso-era placement so the visual is unchanged.
 *
 * Exported for unit testing — the only branchable logic is the
 * isAtBottom → null-vs-render decision.
 */
export function ScrollToBottomButton() {
	const { isAtBottom, scrollToBottom } = useStickToBottomContext();
	const setAtBottom = useSetAtom(activeChatAtBottomAtom);
	const activeAgentId = useAtomValue(activeAgentIdAtom);
	const wasAtBottomRef = useRef(isAtBottom);

	useEffect(() => {
		setAtBottom(isAtBottom);
	}, [isAtBottom, setAtBottom]);

	// Clear the "recently completed" flag when the user scrolls back to
	// bottom — they've seen the latest output. Without this, scrolling
	// back up after acknowledging would re-show the green border.
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

	return (
		<button
			type="button"
			onClick={() => scrollToBottom()}
			aria-label="Scroll to bottom"
			title="Scroll to bottom"
			className={cn(
				"absolute bottom-4 right-4 z-10 flex size-8 items-center justify-center rounded-full transition-all duration-300 ease-out",
				isAtBottom
					? "pointer-events-none scale-75 opacity-0"
					: "scale-100 opacity-100 bg-card shadow-md backdrop-blur-sm flowing-border",
			)}
		>
			<ChevronDown
				className={cn(
					"size-4 transition-all duration-300 ease-out",
					isAtBottom ? "opacity-0" : "text-muted-foreground",
				)}
			/>
		</button>
	);
}

export default ChatPanel;
