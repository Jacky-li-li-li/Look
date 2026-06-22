// ============================================================
// ChatInput — Textarea + Skill Slash Menu + Toolbar (Ink Wash)
// ============================================================

import { Button } from "@shared/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@shared/components/ui/popover";
import { ScrollArea } from "@shared/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@shared/components/ui/tabs";
import { Textarea } from "@shared/components/ui/textarea";
import type { SessionStatus, ThinkingLevel } from "@shared/types";
import { Puzzle, Search, Send, Square } from "lucide-react";
import type React from "react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ContextRing from "./ContextRing";
import ModelSelector from "./ModelSelector";
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
	agentStatus: SessionStatus;
	currentModel: string;
	currentThinking: string;
	availableThinkingLevels?: ThinkingLevel[];
	isBusy: boolean;
	onSend: (text: string) => void;
	onThinkingChange: (level: string) => void;
	onModelChange: (model: string) => void;
	onRequestApiKeys?: () => void;
	onAbort?: () => void;
}

const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
	{
		agentId,
		agentStatus,
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

	// ---- MCP tools: lazy-load + # menu state ----
	const [mcpTools, setMcpTools] = useState<{ name: string; description: string; serverName: string }[]>([]);
	const [hashIndex, setHashIndex] = useState(0);
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const [list, det, mcp] = await Promise.all([
					window.look.listSkills(),
					window.look.detectCommonSkillPaths(),
					window.look.listMcpTools?.() ?? Promise.resolve({ success: false, tools: [] }),
				]);
				if (cancelled) return;
				if (list.success) {
					setSkills(list.skills ?? []);
					setImportedPaths(list.importedPaths ?? []);
				}
				if (det.success) {
					setDetected(det.detected ?? []);
				}
				if (mcp.success) {
					setMcpTools(mcp.tools ?? []);
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

	// Hash menu visibility — triggered by "#mcp" so users can pick an MCP tool.
	const hashOpen = useMemo(() => /^#mcp[^\s]*$/.test(input), [input]);

	const fetchMcpTools = useCallback(async () => {
		try {
			const mcp = await window.look.listMcpTools();
			if (mcp.success) setMcpTools(mcp.tools ?? []);
		} catch {
			// ignore
		}
	}, []);

	useEffect(() => {
		if (hashOpen) {
			setHashIndex(0);
			// Re-fetch MCP tools when the user opens the # menu.
			// This triggers auto-connect on the main process side if
			// no servers are connected yet.
			fetchMcpTools();
		}
	}, [hashOpen, fetchMcpTools]);
	const hashSearchTerm = useMemo(() => {
		// Strip the "#mcp" prefix; anything left is the search filter.
		return input.replace(/^#mcp/, "");
	}, [input]);
	const filteredMcpTools = useMemo(() => {
		if (!hashSearchTerm) return mcpTools;
		const term = hashSearchTerm.toLowerCase();
		return mcpTools.filter(
			(t) =>
				t.name.toLowerCase().includes(term) ||
				t.serverName.toLowerCase().includes(term) ||
				t.description?.toLowerCase().includes(term),
		);
	}, [mcpTools, hashSearchTerm]);
	const commitHashSelection = useCallback(
		(index: number) => {
			const t = filteredMcpTools[index];
			if (t) setInput(`mcp:${t.serverName}:${t.name} `);
		},
		[filteredMcpTools],
	);
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

	// ---- Tools popover (manual skill / MCP picker) ----
	const [toolsOpen, setToolsOpen] = useState(false);
	const [toolsSearch, setToolsSearch] = useState("");
	useEffect(() => {
		if (toolsOpen) {
			// Refresh MCP tools when the picker opens; this also triggers
			// auto-connect on the main side if servers are not connected yet.
			fetchMcpTools();
		} else {
			setToolsSearch("");
		}
	}, [toolsOpen, fetchMcpTools]);

	const searchedSkills = useMemo(() => {
		if (!toolsSearch.trim()) return visibleSkills;
		const term = toolsSearch.toLowerCase();
		return visibleSkills.filter(
			(s) => s.name.toLowerCase().includes(term) || s.description.toLowerCase().includes(term),
		);
	}, [visibleSkills, toolsSearch]);

	const searchedMcpTools = useMemo(() => {
		if (!toolsSearch.trim()) return mcpTools;
		const term = toolsSearch.toLowerCase();
		return mcpTools.filter(
			(t) =>
				t.name.toLowerCase().includes(term) ||
				t.serverName.toLowerCase().includes(term) ||
				t.description?.toLowerCase().includes(term),
		);
	}, [mcpTools, toolsSearch]);

	const handlePickSkill = useCallback((name: string) => {
		setInput(`/skill:${name} `);
		setToolsOpen(false);
		setToolsSearch("");
		inputRef.current?.focus();
	}, []);

	const handlePickMcpTool = useCallback((serverName: string, toolName: string) => {
		setInput(`mcp:${serverName}:${toolName} `);
		setToolsOpen(false);
		setToolsSearch("");
		inputRef.current?.focus();
	}, []);

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

		// Hash (#) menu — MCP tools
		if (
			hashOpen &&
			filteredMcpTools.length > 0 &&
			handleSlashMenuKey(
				e,
				{ open: true, selectedIndex: hashIndex, pickableCount: filteredMcpTools.length },
				(next) => {
					setHashIndex(next.selectedIndex);
					if (!next.open) {
						setInput("");
					}
				},
			)
		) {
			if (e.key === "Enter" || e.key === "Tab") {
				commitHashSelection(hashIndex);
			}
			return;
		}

		if (e.key === "Enter" && !e.shiftKey && !(e.nativeEvent as KeyboardEvent).isComposing) {
			e.preventDefault();
			handleSend();
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
				{hashOpen ? (
					mcpTools.length === 0 ? (
						<div className="absolute bottom-full left-0 right-0 z-50 mb-1 rounded-lg border border-hairline bg-popover p-3 text-center text-xs text-muted-foreground shadow-lg">
							Type <span className="font-medium text-foreground">#mcp</span> to use MCP tools.
							<br />
							Add a server in <span className="font-medium text-foreground">Settings → MCP</span>.
						</div>
					) : filteredMcpTools.length > 0 ? (
						<div className="absolute bottom-full left-0 right-0 z-50 mb-1 max-h-48 overflow-y-auto rounded-lg border border-hairline bg-popover p-1 shadow-lg">
							<div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
								MCP Tools
							</div>
							{filteredMcpTools.map((t, i) => (
								<button
									key={`${t.serverName}__${t.name}`}
									type="button"
									className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
										i === hashIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/40"
									}`}
									onMouseDown={(e) => {
										e.preventDefault();
										setInput(`mcp:${t.serverName}:${t.name} `);
									}}
								>
									<span className="shrink-0 rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
										{t.serverName}
									</span>
									<span className="font-medium">{t.name}</span>
									{t.description && <span className="truncate text-muted-foreground">— {t.description}</span>}
								</button>
							))}
						</div>
					) : (
						<div className="absolute bottom-full left-0 right-0 z-50 mb-1 rounded-lg border border-hairline bg-popover p-3 text-center text-xs text-muted-foreground shadow-lg">
							No matching MCP tools for "{hashSearchTerm}".
						</div>
					)
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
					<ThinkingSelector
						currentLevel={currentThinking}
						availableThinkingLevels={availableThinkingLevels}
						onChanged={onThinkingChange}
					/>
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
							<Tabs defaultValue="skills" className="flex flex-col">
								<div className="border-b border-hairline px-2 pt-2">
									<TabsList className="grid w-full grid-cols-2 bg-transparent p-0">
										<TabsTrigger
											value="skills"
											className="rounded-none border-b-2 border-transparent py-1.5 text-xs data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
										>
											{t("chat.skills", "Skills")}
											{visibleSkills.length > 0 && (
												<span className="ml-1.5 rounded-full bg-muted px-1.5 py-0 text-[10px] tabular-nums text-muted-foreground">
													{searchedSkills.length}
												</span>
											)}
										</TabsTrigger>
										<TabsTrigger
											value="mcp"
											className="rounded-none border-b-2 border-transparent py-1.5 text-xs data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
										>
											{t("chat.mcpTools", "MCP Tools")}
											{mcpTools.length > 0 && (
												<span className="ml-1.5 rounded-full bg-muted px-1.5 py-0 text-[10px] tabular-nums text-muted-foreground">
													{searchedMcpTools.length}
												</span>
											)}
										</TabsTrigger>
									</TabsList>
								</div>
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
								<TabsContent value="skills" className="mt-0">
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
								</TabsContent>
								<TabsContent value="mcp" className="mt-0">
									<ScrollArea className="h-60">
										{searchedMcpTools.length > 0 ? (
											<div className="p-1.5">
												{searchedMcpTools.map((t) => (
													<button
														key={`mcp-${t.serverName}-${t.name}`}
														type="button"
														className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
														onClick={() => handlePickMcpTool(t.serverName, t.name)}
													>
														<span className="shrink-0 rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
															{t.serverName}
														</span>
														<span className="font-medium">{t.name}</span>
													</button>
												))}
											</div>
										) : (
											<div className="flex h-full flex-col items-center justify-center px-4 py-8 text-center text-xs text-muted-foreground">
												{toolsSearch.trim()
													? t("chat.noMcpToolsFound", "No MCP tools match your search.")
													: t("chat.noMcpTools", "No MCP tools connected.")}
											</div>
										)}
									</ScrollArea>
								</TabsContent>
							</Tabs>
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
	);
});

export default ChatInput;
