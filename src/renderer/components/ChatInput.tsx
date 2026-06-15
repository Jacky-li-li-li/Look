// ============================================================
// ChatInput — Textarea + Skill Slash Menu + Toolbar (Ink Wash)
// ============================================================

import { Button } from "@shared/components/ui/button";
import { Textarea } from "@shared/components/ui/textarea";
import type { AgentStatus, PermissionMode } from "@shared/types";
import { Send, Square } from "lucide-react";
import type React from "react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ContextRing from "./ContextRing";
import ModelSelector from "./ModelSelector";
import { PermissionModeSelector } from "./PermissionModeSelector";
import SkillOverlaySegments from "./SkillOverlaySegments";
import { type CommonSkillPath, handleSlashMenuKey, type SkillEntry, SkillSlashMenu } from "./SkillSlashMenu";
import ThinkingSelector from "./ThinkingSelector";

export interface ChatInputHandle {
	getText: () => string;
	setText: (text: string) => void;
	focus: () => void;
}

interface ChatInputProps {
	agentId: string;
	agentStatus: AgentStatus;
	currentModel: string;
	currentThinking: string;
	currentPermissionMode: PermissionMode;
	isBusy: boolean;
	onSend: (text: string) => void;
	onThinkingChange: (level: string) => void;
	onModelChange: (model: string) => void;
	onPermissionModeChange: (mode: PermissionMode) => void;
	onRequestApiKeys?: () => void;
	onAbort?: () => void;
}

const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
	{
		agentId,
		agentStatus,
		currentModel,
		currentThinking,
		currentPermissionMode,
		isBusy,
		onSend,
		onThinkingChange,
		onModelChange,
		onPermissionModeChange,
		onRequestApiKeys,
		onAbort,
	},
	ref,
) {
	const { t } = useTranslation();
	const [input, setInput] = useState("");
	const inputRef = useRef<HTMLTextAreaElement>(null);

	useImperativeHandle(ref, () => ({
		getText: () => inputRef.current?.value ?? "",
		setText: (text: string) => {
			setInput(text);
			// Also set the DOM value directly so the ref is always in sync
			if (inputRef.current) inputRef.current.value = text;
		},
		focus: () => inputRef.current?.focus(),
	}));

	// ---- v0.3 skills: lazy-load + slash menu state ----
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

	const handleSend = () => {
		const text = input.trim();
		if (!text) return;
		onSend(text);
		setInput("");
	};

	const handleAbort = () => {
		onAbort?.();
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (
			slashOpen &&
			handleSlashMenuKey(e, { open: true, selectedIndex: slashIndex, pickableCount }, (next) => {
				setSlashIndex(next.selectedIndex);
				if (!next.open) {
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
		<div className="shrink-0 border-t border-hairline bg-background/70 px-5 py-2.5 backdrop-blur-md">
			<div className="relative rounded-lg border border-hairline bg-card/60 shadow-none backdrop-blur-sm">
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
							setInput("");
						}}
						onClose={() => setInput("")}
					/>
				) : null}
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
	);
});

export default ChatInput;
