// ============================================================
// ChatInput — ContentEditableInput + Skill Slash Menu + Toolbar
//            (Ink Wash)
// ============================================================

import { Button } from "@shared/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@shared/components/ui/dialog";
import type { ImageContent, ThinkingLevel } from "@shared/types";
import { useAtom, useAtomValue } from "jotai";
import { Send, Square, X } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { agentDefinitionsAtom } from "../store/agentDefinitionsAtoms";
import {
	enabledAgentDefinitionsAtom,
	enabledSkillsAtom,
	permissionModeAtomFamily,
	subagentEnabledAtom,
} from "../store/atoms";
import { AgentHashMenu } from "./AgentHashMenu";
import ContentEditableInput, { type ContentEditableInputHandle } from "./ContentEditableInput";
import ContextRing from "./ContextRing";
import { handleSlashMenuKey } from "./handleSlashMenuKey";
import ModelSelector from "./ModelSelector";
import PermissionModeSelector from "./PermissionModeSelector";
import { type CommonSkillPath, type SkillEntry, SkillSlashMenu } from "./SkillSlashMenu";
import SubagentToggle from "./SubagentToggle";
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
	onSend: (text: string, images?: ImageContent[]) => Promise<boolean>;
	onThinkingChange: (level: string) => void;
	onModelChange: (model: string) => void;
	onRequestApiKeys?: () => void;
	onAbort?: () => void;
	ref?: React.Ref<ChatInputHandle>;
}

const ChatInput = function ChatInput({
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
	ref,
}: ChatInputProps) {
	const { t } = useTranslation();
	const [permissionMode, setPermissionMode] = useAtom(permissionModeAtomFamily(agentId));
	const [input, setInputState] = useState("");
	const inputRef = useRef<ContentEditableInputHandle>(null);
	// Undo stack — user-driven edits push the previous text; Cmd+Z pops.
	const undoStackRef = useRef<string[]>([]);
	const MAX_UNDO = 80;
	// Snapshot of `input` kept in-sync via a ref so the onChange callback
	// (which has an empty deps array) always sees the current value.
	const inputSnapshotRef = useRef(input);
	inputSnapshotRef.current = input;
	// Pending images pasted from clipboard, shown as thumbnails above the input.
	const [pendingImages, setPendingImages] = useState<ImageContent[]>([]);
	// Index of the image currently shown in the zoom dialog (-1 = closed).
	const [zoomedImageIndex, setZoomedImageIndex] = useState(-1);

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

	// ---- 已启用集合（来自主进程 general settings,广场关闭后弹窗要隐藏） ----
	// `null` 表示"全部启用"。广场 onChange 也会即时更新此 atom,
	// 挂载时再拉一次作为兜底,覆盖应用启动 / 跨会话 / 外部修改等场景。
	const [enabledAgentDefs, setEnabledAgentDefs] = useAtom(enabledAgentDefinitionsAtom);
	const [enabledSkills, setEnabledSkills] = useAtom(enabledSkillsAtom);
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const result = await window.look.getGeneralSettings();
				if (cancelled || !result?.success || !result.settings) return;
				const settings = result.settings as {
					enabledAgentDefinitions?: string[] | null;
					enabledSkills?: string[] | null;
				};
				setEnabledAgentDefs(settings.enabledAgentDefinitions ?? null);
				setEnabledSkills(settings.enabledSkills ?? null);
			} catch {
				// Non-fatal: 默认全启用,不会隐藏任何选项。
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [setEnabledAgentDefs, setEnabledSkills]);
	// Slash menu visibility — true when the input looks like `/xxx`
	// without any whitespace (so mid-sentence `/` doesn't trigger).
	const slashOpen = useMemo(() => /^\/[^\s]*$/.test(input), [input]);
	// Reset index whenever the menu re-opens (inline during render)
	const [prevSlashOpen, setPrevSlashOpen] = useState(false);
	if (slashOpen !== prevSlashOpen) {
		setPrevSlashOpen(slashOpen);
		if (slashOpen) setSlashIndex(0);
	}
	// ---- # Agent 选择菜单 ----
	const agentDefs = useAtomValue(agentDefinitionsAtom);
	const subagentOn = useAtomValue(subagentEnabledAtom);
	const [hashIndex, setHashIndex] = useState(0);
	// 输入中包含独立的 # 时显示 Agent 选择面板（支持开头或中间触发）
	const hashOpen = useMemo(() => /(?:^|\s)#[^\s]*$/.test(input), [input]);
	const [prevHashOpen, setPrevHashOpen] = useState(false);
	if (hashOpen !== prevHashOpen) {
		setPrevHashOpen(hashOpen);
		if (hashOpen) setHashIndex(0);
	}
	// 提取最后一个 # 后的搜索关键词
	const hashSearchTerm = useMemo(() => {
		const m = input.match(/#([^\s]*)$/);
		return m ? m[1] : "";
	}, [input]);
	// 按名称、标题、描述过滤 Agent（先按广场启用状态过滤掉关闭的）
	const filteredAgents = useMemo(() => {
		let list = agentDefs;
		if (enabledAgentDefs !== null) {
			list = list.filter((a) => enabledAgentDefs.includes(a.name));
		}
		if (!hashSearchTerm) return list;
		const term = hashSearchTerm.toLowerCase();
		return list.filter(
			(a) =>
				a.name.toLowerCase().includes(term) ||
				(a.title ?? "").toLowerCase().includes(term) ||
				a.description.toLowerCase().includes(term),
		);
	}, [agentDefs, hashSearchTerm, enabledAgentDefs]);
	// 提交选中的 Agent：替换最后一个 #term 为 #agentName
	const commitHashSelection = useCallback(
		(index: number) => {
			const a = filteredAgents[index];
			if (!a) return;
			const replaced = input.replace(/#[^\s]*$/, `#${a.name} `);
			setInput(replaced);
		},
		[filteredAgents, setInput, input],
	);

	// Compute pickable count so handleSlashMenuKey can wrap-around.
	// 过滤掉广场关闭的 Skill（null = 全部启用）和 disableModelInvocation 的隐藏项
	const visibleSkills = useMemo(() => {
		let list = skills.filter((s) => !s.disableModelInvocation);
		if (enabledSkills !== null) {
			list = list.filter((s) => enabledSkills.includes(s.name));
		}
		return list;
	}, [skills, enabledSkills]);
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

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	// ---- Image paste handler ----
	const handleImagesPasted = useCallback((images: ImageContent[]) => {
		setPendingImages((prev) => [...prev, ...images]);
	}, []);

	const handleRemoveImage = useCallback((index: number) => {
		setPendingImages((prev) => prev.filter((_, i) => i !== index));
	}, []);

	const hasContent = input.trim().length > 0 || pendingImages.length > 0;

	const handleSend = async () => {
		const text = (inputRef.current?.getText() ?? "").trim();
		if (!text && pendingImages.length === 0) return;
		const images = pendingImages.length > 0 ? pendingImages : undefined;
		if (images) {
			console.log(
				"[ChatInput] sending images:",
				images.map((img) => ({ mimeType: img.mimeType, dataLen: img.data.length })),
			);
		}
		if (await onSend(text || "", images)) {
			setInput("");
			setPendingImages([]);
		}
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
		const prev = inputSnapshotRef.current;
		if (text !== prev) {
			undoStackRef.current.push(prev);
			if (undoStackRef.current.length > MAX_UNDO) {
				undoStackRef.current.shift();
			}
		}
		setInputState(text);
	}, []);

	const handleEditorKeyDown = (e: React.KeyboardEvent) => {
		// Cmd+Z / Ctrl+Z — undo last user edit
		if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
			e.preventDefault();
			const prev = undoStackRef.current.pop();
			if (prev !== undefined) {
				setInput(prev);
			}
			return;
		}
		// # Agent 选择菜单键盘处理
		if (hashOpen && filteredAgents.length > 0) {
			const handled = handleSlashMenuKey(
				e,
				{ open: true, selectedIndex: hashIndex, pickableCount: filteredAgents.length },
				(next) => {
					setHashIndex(next.selectedIndex);
					if (!next.open) setInput(input.replace(/#[^\s]*$/, "").trimEnd());
				},
			);
			if (handled) {
				if (e.key === "Enter" || e.key === "Tab") {
					commitHashSelection(hashIndex);
				}
				return;
			}
		}
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
			{hashOpen ? (
				<AgentHashMenu
					agents={filteredAgents}
					searchTerm={hashSearchTerm}
					selectedIndex={hashIndex}
					onSelectedIndexChange={setHashIndex}
					onSelectAgent={(a) => {
						const replaced = input.replace(/#[^\s]*$/, `#${a.name} `);
						setInput(replaced);
					}}
					onClose={() => {
						const cleaned = input.replace(/#[^\s]*$/, "").trimEnd();
						setInput(cleaned);
					}}
					subagentEnabled={subagentOn}
				/>
			) : null}
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

			{/* Pending image previews */}
			{pendingImages.length > 0 && (
				<div className="flex flex-wrap gap-2 px-3 pt-2.5">
					{pendingImages.map((img, idx) => (
						<div
							key={`${img.mimeType}-${idx}`}
							className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-hairline bg-muted"
						>
							<button
								type="button"
								onClick={() => setZoomedImageIndex(idx)}
								className="h-full w-full cursor-zoom-in"
								aria-label={`View image ${idx + 1}`}
							>
								<img
									src={`data:${img.mimeType};base64,${img.data}`}
									alt={`用户粘贴的图片 ${idx + 1}`}
									className="h-full w-full object-cover"
								/>
							</button>
							<button
								type="button"
								onClick={() => handleRemoveImage(idx)}
								className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-background/80 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive hover:text-destructive-foreground group-hover:opacity-100"
								aria-label={`Remove image ${idx + 1}`}
							>
								<X className="size-3" />
							</button>
						</div>
					))}
				</div>
			)}

			{/* Enlarged image dialog */}
			<Dialog
				open={zoomedImageIndex >= 0}
				onOpenChange={(open) => {
					if (!open) setZoomedImageIndex(-1);
				}}
			>
				<DialogContent
					showCloseButton={false}
					className="max-w-[90vw] max-h-[90vh] border-0 bg-transparent p-0 shadow-none"
					onClick={() => setZoomedImageIndex(-1)}
				>
					<DialogTitle className="sr-only">
						{zoomedImageIndex >= 0 ? `Image ${zoomedImageIndex + 1}` : "Image preview"}
					</DialogTitle>
					{zoomedImageIndex >= 0 && pendingImages[zoomedImageIndex] && (
						<div onClick={(e) => e.stopPropagation()} role="presentation">
							<img
								src={`data:${pendingImages[zoomedImageIndex].mimeType};base64,${pendingImages[zoomedImageIndex].data}`}
								alt={`放大的图片 ${zoomedImageIndex + 1}`}
								className="max-h-[85vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
							/>
						</div>
					)}
				</DialogContent>
			</Dialog>

			<ContentEditableInput
				ref={inputRef}
				placeholder={isBusy ? `${t("chat.send")}… (Enter to queue)` : `${t("chat.placeholder")}`}
				onChange={handleEditorChange}
				onImagesPasted={handleImagesPasted}
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
				<SubagentToggle />
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
							variant={hasContent ? "line-filled" : "line"}
							size="icon-sm"
							onClick={() => void handleSend()}
							disabled={!hasContent}
							aria-label={t("chat.send")}
						>
							<Send data-icon="inline-start" className="size-3.5" />
						</Button>
					</>
				) : (
					<Button
						variant={hasContent ? "line-filled" : "line"}
						size="icon-sm"
						onClick={() => void handleSend()}
						disabled={!hasContent}
						aria-label={t("chat.send")}
					>
						<Send data-icon="inline-start" className="size-3.5" />
					</Button>
				)}
			</div>
		</div>
	);
};

export default ChatInput;
