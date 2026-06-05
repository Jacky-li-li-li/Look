// ============================================================
// ChatPanel — Whisper Bubbles + Line Input (Ink Wash, shadcn/ui)
// ============================================================

import { Button } from "@shared/components/ui/button";
import { Textarea } from "@shared/components/ui/textarea";
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
	const importableDetected = useMemo(
		() => detected.filter((d) => d.exists && !importedPaths.includes(d.path)),
		[detected, importedPaths],
	);
	const pickableCount = visibleSkills.length + importableDetected.length;
	// Commit a chosen skill name into the input.
	const commitSlashSelection = useCallback(
		(index: number) => {
			if (index < visibleSkills.length) {
				const s = visibleSkills[index];
				if (s) setInput(`/skill:${s.name} `);
			} else {
				const i = index - visibleSkills.length;
				const d = importableDetected[i];
				if (d) void importDetected(d);
			}
		},
		[visibleSkills, importableDetected],
	);
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

	// Batch scroll to bottom via rAF — avoids forced layout on every streaming delta
	useEffect(() => {
		cancelAnimationFrame(rafRef.current!);
		rafRef.current = requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
		return () => cancelAnimationFrame(rafRef.current!);
	}, []);
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	// Merge consecutive assistant messages (pi may split thinking/tools/output across turns)
	const displayMessages = useMemo(() => {
		const merged: AgentMessage[] = [];
		for (const msg of messages) {
			const last = merged[merged.length - 1];
			if (last && last.role === "assistant" && msg.role === "assistant") {
				merged[merged.length - 1] = {
					...last,
					content: last.content + (last.content && msg.content ? "\n\n" : "") + (msg.content || ""),
					thinking: (last.thinking || "") + (msg.thinking || ""),
					toolCalls: [...(last.toolCalls ?? []), ...(msg.toolCalls ?? [])],
					isStreaming: msg.isStreaming ?? last.isStreaming,
				};
			} else {
				merged.push(msg);
			}
		}
		return merged;
	}, [messages]);

	const handleSend = () => {
		const text = input.trim();
		if (!text) return;
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
			if (e.key === "Enter") {
				commitSlashSelection(slashIndex);
			}
			return;
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	const isBusy = agentStatus === "thinking" || agentStatus === "working";

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

			<div className="shrink-0 border-t border-hairline bg-background/70 px-4 py-2.5 backdrop-blur-md">
				<div className="relative mx-auto max-w-[52rem] rounded-lg border border-hairline bg-card/60 shadow-none backdrop-blur-sm">
					{/* v0.3: /skill:name slash menu — absolute-positioned
					    above the textarea. Absolute so it doesn't push
					    the messages area when it opens. */}
					{slashOpen ? (
						<SkillSlashMenu
							skills={skills}
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
						placeholder={isBusy ? "Agent is working..." : `Message ${agentName ?? "agent"}… (type / for skills)`}
						rows={2}
						disabled={isBusy}
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
							// P2-2: Stop button replaces Send while the agent is
							// busy. Click → onAbort → agent:abort IPC → m.session.abort().
							// We deliberately do NOT show a confirmation — Stop is
							// always recoverable (user can re-prompt), so a
							// confirmation adds friction without real value.
							<Button
								variant="line"
								size="icon-sm"
								onClick={onAbort}
								aria-label="Stop agent"
								title="Stop"
								className="text-muted-foreground hover:text-foreground"
							>
								<Square data-icon="inline-start" className="size-3 fill-current" />
							</Button>
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
