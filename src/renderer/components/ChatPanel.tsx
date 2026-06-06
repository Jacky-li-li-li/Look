// ============================================================
// ChatPanel — Whisper Bubbles + Line Input (Ink Wash, shadcn/ui)
// ============================================================

import { Button } from "@shared/components/ui/button";
import { Textarea } from "@shared/components/ui/textarea";
import { cn } from "@shared/lib/utils";
import type { AgentMessage, AgentRole, AgentStatus, PermissionMode } from "@shared/types";
import { MessageSquare, Send, Square } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ContextRing from "./ContextRing";
import MessageBubble from "./MessageBubble";
import ModelSelector from "./ModelSelector";
import { PermissionModeSelector } from "./PermissionModeSelector";
import { PixelAgentAvatar } from "./PixelAgentAvatar";
import { type CommonSkillPath, handleSlashMenuKey, type SkillEntry, SkillSlashMenu } from "./SkillSlashMenu";
import ThinkingSelector from "./ThinkingSelector";

interface ChatPanelProps {
	agentId: string;
	agentRole?: AgentRole;
	agentName?: string;
	messages: AgentMessage[];
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
	/**
	 * Fired when the user clicks the Stop button (visible while the
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
	const [input, setInput] = useState("");
	const bottomRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const rafRef = useRef<number | undefined>(undefined);
	const composingRef = useRef(false); // track IME composition state

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

	// Batch scroll to bottom via rAF — avoids forced layout on every streaming delta
	useEffect(() => {
		cancelAnimationFrame(rafRef.current!);
		rafRef.current = requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
		return () => cancelAnimationFrame(rafRef.current!);
	}, []);
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

	// Merge ALL consecutive assistant messages into one bubble per user message.
	// Each assistant message becomes a separate "chunk" so the UI can show
	// multi-step reasoning (e.g. "Let me read first" → tools → "Now I'll explain")
	// under a **single** agent label, instead of merging all text into one blob.
	//
	// Tool-result messages are NOT standalone bubbles — they attach to the
	// most recent pending toolCall in the most recent assistant chunk.
	const displayMessages = useMemo(() => {
		const merged: AgentMessage[] = [];

		/** Attach a tool result to the FIFO-pending toolCall in the last assistant.
		 *  Searches backwards through merged[], then **forward** through chunks
		 *  (oldest chunk first) so the pending toolCall from the earliest-assigned
		 *  tool block gets its result first — matching the SDK's emit order:
		 *  assistant emits blocks sequentially → tools from earlier blocks
		 *  have their results arrive earlier on average. */
		function attachToolResult(resultText: string) {
			for (let i = merged.length - 1; i >= 0; i--) {
				const a = merged[i];
				if (a.role !== "assistant") continue;

				const chunks = a.assistantChunks;
				if (chunks) {
					// Forward-chunk search: oldest chunk's pending toolCall first
					for (let c = 0; c < chunks.length; c++) {
						const chunk = chunks[c];
						if (!chunk.toolCalls) continue;
						const pendingIdx = chunk.toolCalls.findIndex((tc) => !tc.result);
						if (pendingIdx >= 0) {
							const newTCs = chunk.toolCalls.slice();
							newTCs[pendingIdx] = { ...newTCs[pendingIdx], result: resultText, isError: false };
							chunks[c] = { ...chunk, toolCalls: newTCs };
							merged[i] = { ...a, assistantChunks: chunks.slice() };
							return true;
						}
					}
				} else {
					// Legacy flat toolCalls
					if (!a.toolCalls) continue;
					const pendingIdx = a.toolCalls.findIndex((tc) => !tc.result);
					if (pendingIdx >= 0) {
						const newTCs = a.toolCalls.slice();
						newTCs[pendingIdx] = { ...newTCs[pendingIdx], result: resultText, isError: false };
						merged[i] = { ...a, toolCalls: newTCs };
						return true;
					}
				}
			}
			return false;
		}

		for (const msg of messages) {
			if (msg.role === "tool") {
				const resultText = msg.content;
				if (!resultText) continue;
				attachToolResult(resultText);
				continue; // do NOT push tool message as its own element
			}

			const last = merged[merged.length - 1];

			if (last && last.role === "assistant" && msg.role === "assistant") {
				// ── Consecutive assistant → push as a new CHUNK ──
				// Preserve each assistant message as its own chunk so the UI can
				// render them as separate blocks under ONE agent label.

				// Deduplicate toolCalls by callId
				const newToolCalls = (msg.toolCalls ?? []).map((tc) => ({
					...tc,
					result: tc.result ?? "",
					isError: tc.isError ?? false,
				}));

				const existingChunks = last.assistantChunks ?? [
					{
						content: last.content,
						thinking: last.thinking,
						toolCalls: last.toolCalls,
					},
				];

				existingChunks.push({
					content: msg.content || "",
					thinking: msg.thinking,
					toolCalls: newToolCalls.length > 0 ? newToolCalls : undefined,
				});

				// Keep the legacy content/toolCalls for simpler components that
				// don't understand chunks. `last.content` is the *last* chunk's
				// text (for collapsing empty assistant texts into previous).
				const allContent = existingChunks
					.map((c) => c.content)
					.filter(Boolean)
					.join("\n\n");
				const flatToolCalls = existingChunks.flatMap((c) => c.toolCalls ?? []);

				merged[merged.length - 1] = {
					...last,
					content: allContent,
					toolCalls: flatToolCalls.length > 0 ? flatToolCalls : undefined,
					assistantChunks: existingChunks,
					isStreaming: msg.isStreaming ?? last.isStreaming,
				};
			} else {
				merged.push(msg);
			}
		}
		// Hide last N user messages when the SDK queue is non-empty
		// (they show in the drawer instead). N = steering + followUp —
		// matches the drawer's depth display.
		const hideCount = queue.steering.length + queue.followUp.length;
		if (hideCount > 0) {
			const hideIndices = new Set<number>();
			let remaining = hideCount;
			for (let i = merged.length - 1; i >= 0 && remaining > 0; i--) {
				if (merged[i].role === "user") {
					hideIndices.add(i);
					remaining--;
				}
			}
			return merged.filter((_, i) => !hideIndices.has(i));
		}
		return merged;
	}, [messages, queue.steering.length, queue.followUp.length]);

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
		if (e.key === "Enter" && !e.shiftKey && !composingRef.current) {
			e.preventDefault();
			handleSend();
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-[52rem] flex-col gap-5 px-5 py-5">
					{displayMessages.length === 0 ? (
						<div className="flex min-h-[52vh] flex-col items-center justify-center gap-4 text-center">
							<div className="relative">
								<PixelAgentAvatar role={agentRole} status={agentStatus} size="lg" />
								<MessageSquare className="absolute -right-2 -bottom-2 size-5 rounded-md border border-hairline bg-background p-1 text-foreground" />
							</div>
							<div className="flex flex-col gap-1">
								<h3 className="text-[13px] font-semibold text-foreground">No messages yet</h3>
								<p className="text-[11px] text-muted-foreground">Start with a direct task for this agent.</p>
							</div>
						</div>
					) : (
						displayMessages.map((msg) => (
							<MessageBubble key={msg.id} message={msg} agentRole={agentRole} agentName={agentName} />
						))
					)}
					<div ref={bottomRef} />
				</div>
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
				<div className="mx-auto w-full max-w-[52rem] px-5 py-2">
					<div className="mb-1.5 flex items-center gap-2">
						<span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
							Queued
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

			<div className="shrink-0 border-t border-hairline bg-background/70 px-4 py-2.5 backdrop-blur-md">
				<div className="relative mx-auto max-w-[52rem] rounded-lg border border-hairline bg-card/60 shadow-none backdrop-blur-sm">
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
					<Textarea
						ref={inputRef}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={handleKeyDown}
						onCompositionStart={() => {
							composingRef.current = true;
						}}
						onCompositionEnd={() => {
							composingRef.current = false;
						}}
						placeholder={
							isBusy
								? "Agent is working… (Enter to queue message)"
								: `Message ${agentName ?? "agent"}… (type / for skills)`
						}
						rows={2}
						className="min-h-16 resize-none rounded-none border-0 bg-transparent px-3 py-2.5 text-[13px] shadow-none placeholder:text-muted-foreground/50 focus-visible:ring-0 focus-visible:outline-0"
					/>
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
									aria-label="Stop agent"
									title="Stop"
									className="text-muted-foreground hover:text-destructive"
								>
									<Square data-icon="inline-start" className="size-3 fill-current" />
								</Button>
								<Button
									variant={input.trim() ? "line-filled" : "line"}
									size="icon-sm"
									onClick={handleSend}
									disabled={!input.trim()}
									aria-label="Queue message"
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
								aria-label="Send message"
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
