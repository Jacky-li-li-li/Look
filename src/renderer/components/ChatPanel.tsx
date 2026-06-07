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
import { ChevronDown, MessageSquare, Send, Square } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
export default function ChatPanel({
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
	const scrollRef = useRef<HTMLDivElement>(null);
	const bottomRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const rafRef = useRef<number | undefined>(undefined);
	const isStickyRef = useRef(true); // user is near the bottom → auto-scroll
	const [showScrollBtn, setShowScrollBtn] = useState(false);

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

	// ---- Sticky auto-scroll ----
	// Only auto-scroll to bottom when the user is already near the
	// bottom (within 48px threshold). If they scrolled up to read
	// earlier messages, we don't interrupt them. The isStickyRef
	// is updated on every scroll event and read inside the effect
	// so the effect doesn't need to track it as a dependency.
	// biome-ignore lint/correctness/useExhaustiveDependencies: identity-only trigger for displayMessages; isStickyRef is read inside
	useEffect(() => {
		if (!isStickyRef.current || !scrollRef.current) return;
		cancelAnimationFrame(rafRef.current!);
		rafRef.current = requestAnimationFrame(() => {
			if (scrollRef.current) {
				scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
			}
		});
		return () => cancelAnimationFrame(rafRef.current!);
	}, [displayMessages]);

	const handleScrollToBottom = () => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
		isStickyRef.current = true;
		setShowScrollBtn(false);
	};

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

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div
				ref={scrollRef}
				className="flex-1 overflow-y-auto"
				onScroll={() => {
					const el = scrollRef.current;
					if (!el) return;
					// Within 48px of the bottom → sticky, auto-scroll on next update.
					// Past 48px → not sticky, user is reading earlier content.
					const wasSticky = isStickyRef.current;
					isStickyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
					setShowScrollBtn(!isStickyRef.current);
					// Cancel any in-flight RAF if user breaks away from the bottom,
					// preventing the race: onScroll → isStickyRef=false, but a
					// pending RAF from a recent content-update effect could still
					// fire ~16ms later and yank the user back to bottom.
					if (wasSticky && !isStickyRef.current) {
						cancelAnimationFrame(rafRef.current!);
					}
				}}
			>
				<div className="flex w-full flex-col gap-5 px-5 py-5">
					{displayMessages.length === 0 ? (
						<div className="flex min-h-[52vh] flex-col items-center justify-center gap-4 text-center">
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
						displayMessages.map((msg) => (
							<MessageBubble
								key={msg.id}
								message={msg}
								agentRole={agentRole}
								agentName={agentName}
								autoCollapse={autoCollapse}
							/>
						))
					)}
					<div ref={bottomRef} />
				</div>
			</div>

			{/* Floating scroll-to-bottom button — sits at the bottom of the message area */}
			<div className="relative shrink-0 h-0 z-10">
				<button
					onClick={handleScrollToBottom}
					className={cn(
						"absolute bottom-0 right-4 flex size-8 items-center justify-center rounded-full border border-hairline bg-card shadow-md backdrop-blur-sm transition-all duration-200",
						showScrollBtn
							? "translate-y-0 opacity-100 pointer-events-auto"
							: "translate-y-3 opacity-0 pointer-events-none",
					)}
					aria-label="Scroll to bottom"
					title="Scroll to bottom"
				>
					<ChevronDown className="size-4 text-muted-foreground" />
				</button>
			</div>

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
						<ContextRing agentId={agentId} />
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
		</div>
	);
}
