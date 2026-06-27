// ============================================================
// ChatInput — ContentEditableInput + Skill Slash Menu + Toolbar
//            (Ink Wash)
// ============================================================

import { Button } from "@shared/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@shared/components/ui/popover";
import { ScrollArea } from "@shared/components/ui/scroll-area";
import type { ThinkingLevel } from "@shared/types";
import { useAtom } from "jotai";
import { Puzzle, Search, Send, Square } from "lucide-react";
import type React from "react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { permissionModeAtomFamily } from "../store/atoms";
import ContentEditableInput, { type ContentEditableInputHandle } from "./ContentEditableInput";
import ContextRing from "./ContextRing";
import ModelSelector from "./ModelSelector";
import PermissionModeSelector from "./PermissionModeSelector";
import { type CommonSkillPath, handleSlashMenuKey, type SkillEntry, SkillSlashMenu } from "./SkillSlashMenu";
import ThinkingSelector from "./ThinkingSelector";

export interface ChatInputHandle {
	getText: () => string;
	setText: (text: string) => void;
	focus: () => void;
}

interface ChatInputProps {
	agentId: string;
	currentModel: string;
	currentThinking: string;
	availableThinkingLevels?: ThinkingLevel[];
	isBusy: boolean;
	onSend: (text: string) => Promise<boolean>;
	onThinkingChange: (level: string) => void;
	onModelChange: (model: string) => void;
	onRequestApiKeys?: () => void;
	onAbort?: () => void;
}

const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
	{
		agentId,
		currentModel,
		currentThinking,
		availableThinkingLevels,
		isBusy,
		onSend,
		onThinkingChange,
		onModelChange,
		onRequestApiKeys,
		onAbort,
	},
	ref,
) {
	const { t } = useTranslation();
	const [permissionMode, setPermissionMode] = useAtom(permissionModeAtomFamily(agentId));
	const [input, setInputState] = useState("");
	const inputRef = useRef<ContentEditableInputHandle>(null);

	// setInput is the single mutation entry-point: every
	// programmatic change (slash menu pick, tools picker, send
	// clear, branch-nav injection) flows through it so the
	// React `input` state AND the contenteditable DOM stay in
	// sync. User typing does NOT call this — the editor's
	// onChange updates the state directly via the handler below.
	const setInput = useCallback((text: string) => {
		setInputState(text);
		inputRef.current?.setText(text);
	}, []);

	useEffect(() => {
		let cancelled = false;
		window.look
			.getPermissionMode(agentId)
			.then((result) => {
				if (!cancelled && result?.success && result.mode) setPermissionMode(result.mode);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [agentId, setPermissionMode]);

	useImperativeHandle(
		ref,
		() => ({
			getText: () => inputRef.current?.getText() ?? "",
			setText: (text: string) => {
				setInput(text);
			},
			focus: () => inputRef.current?.focus(),
		}),
		[setInput],
	);

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
		[filteredSkills, importableDetected, importDetected, setInput],
	);

	// ---- Tools popover (manual skill picker) ----
	const [toolsOpen, setToolsOpen] = useState(false);
	const [toolsSearch, setToolsSearch] = useState("");
	useEffect(() => {
		if (!toolsOpen) setToolsSearch("");
	}, [toolsOpen]);

	const searchedSkills = useMemo(() => {
		if (!toolsSearch.trim()) return visibleSkills;
		const term = toolsSearch.toLowerCase();
		return visibleSkills.filter(
			(s) => s.name.toLowerCase().includes(term) || s.description.toLowerCase().includes(term),
		);
	}, [visibleSkills, toolsSearch]);

	const handlePickSkill = useCallback(
		(name: string) => {
			setInput(`/skill:${name} `);
			setToolsOpen(false);
			setToolsSearch("");
			inputRef.current?.focus();
		},
		[setInput],
	);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const handleSend = async () => {
		const text = (inputRef.current?.getText() ?? "").trim();
		if (!text) return;
		if (await onSend(text)) setInput("");
	};

	const handleAbort = () => {
		onAbort?.();
	};

	const handleEditorChange = useCallback((text: string) => {
		// User-driven edit (typing / paste / delete inside the
		// editor). Update the React state only — the editor
		// already mirrors the DOM. Programmatic setInput
		// (commitSlashSelection, setText from outside, …) is a
		// separate path that also re-renders the editor DOM.
		setInputState(text);
	}, []);

	const handleEditorKeyDown = (e: React.KeyboardEvent) => {
		// Slash (/) menu — skills
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
			// isComposing guard: when the user is in an IME
			// candidate window (e.g. Chinese pinyin), Enter
			// commits the candidate, not the editor.
			// ContentEditableInput forwards the event to us
			// during composition so we have to check here.
			e.preventDefault();
			void handleSend();
		}
	};

	return (
		<div className="relative mx-5 mb-2.5 rounded-lg border border-hairline bg-card/60 shadow-none backdrop-blur-sm">
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
			<ContentEditableInput
				ref={inputRef}
				placeholder={isBusy ? `${t("chat.send")}… (Enter to queue)` : `${t("chat.placeholder")}`}
				onChange={handleEditorChange}
				onKeyDown={handleEditorKeyDown}
			/>
			<div className="flex items-center gap-1.5 border-t border-hairline px-2 py-2">
				<ModelSelector
					agentId={agentId}
					currentModel={currentModel}
					onModelChanged={onModelChange}
					onRequestApiKeys={onRequestApiKeys}
				/>
				<ThinkingSelector
					currentLevel={currentThinking}
					availableThinkingLevels={availableThinkingLevels}
					onChanged={onThinkingChange}
				/>
				<PermissionModeSelector agentId={agentId} currentMode={permissionMode} />
				<Popover open={toolsOpen} onOpenChange={setToolsOpen}>
					<PopoverTrigger asChild>
						<Button
							variant="line"
							size="icon-sm"
							aria-label={t("chat.tools", "Tools")}
							title={t("chat.tools", "Tools")}
						>
							<Puzzle className="size-3.5" />
						</Button>
					</PopoverTrigger>
					<PopoverContent
						align="end"
						className="flex w-80 flex-col overflow-hidden rounded-lg border border-hairline bg-popover p-0 shadow-lg"
					>
						<div className="border-b border-hairline px-2 py-2">
							<div className="relative">
								<Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
								<input
									type="text"
									value={toolsSearch}
									onChange={(e) => setToolsSearch(e.target.value)}
									placeholder={t("chat.searchTools", "Search tools...")}
									className="h-8 w-full rounded-md border border-input bg-background pl-7 pr-2 text-xs outline-none ring-0 placeholder:text-muted-foreground focus:border-foreground focus-visible:ring-0"
								/>
							</div>
						</div>
						<ScrollArea className="h-60">
							{searchedSkills.length > 0 ? (
								<div className="p-1.5">
									{searchedSkills.map((s) => (
										<button
											key={`skill-${s.name}`}
											type="button"
											className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
											onClick={() => handlePickSkill(s.name)}
										>
											<span className="font-medium">/skill:{s.name}</span>
											{s.description && (
												<span className="line-clamp-1 text-[10px] text-muted-foreground">
													{s.description}
												</span>
											)}
										</button>
									))}
								</div>
							) : (
								<div className="flex h-full flex-col items-center justify-center px-4 py-8 text-center text-xs text-muted-foreground">
									{toolsSearch.trim()
										? t("chat.noSkillsFound", "No skills match your search.")
										: t("chat.noSkills", "No skills available.")}
								</div>
							)}
						</ScrollArea>
					</PopoverContent>
				</Popover>
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
							onClick={() => void handleSend()}
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
						onClick={() => void handleSend()}
						disabled={!input.trim()}
						aria-label={t("chat.send")}
					>
						<Send data-icon="inline-start" className="size-3.5" />
					</Button>
				)}
			</div>
		</div>
	);
});

export default ChatInput;
