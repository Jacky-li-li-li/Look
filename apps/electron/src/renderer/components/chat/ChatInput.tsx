// ============================================================
// ChatInput — ContentEditableInput + Skill Slash Menu + Toolbar
//            (Ink Wash)
// ============================================================

import type { ImageContent, ThinkingLevel } from "@shared/types";
import { useAtom } from "jotai";
import type React from "react";
import { memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChatInputMenus } from "../../hooks/useChatInputMenus";
import { chatInputInsertRequestAtom, permissionModeAtomFamily } from "../../store/atoms";
import { AgentHashMenu } from "./AgentHashMenu";
import ChatInputToolbar from "./ChatInputToolbar";
import ContentEditableInput, { type ContentEditableInputHandle } from "./ContentEditableInput";
import ImagePreviewBar from "./ImagePreviewBar";
import { McpHashMenu } from "./McpHashMenu";
import { SkillSlashMenu } from "./SkillSlashMenu";

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
	isCompacting?: boolean;
	onSend: (text: string, images?: ImageContent[], sendMode?: "steer" | "followUp") => Promise<boolean>;
	onThinkingChange: (level: ThinkingLevel) => void;
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
	isCompacting,
	onSend,
	onThinkingChange,
	onModelChange,
	onRequestApiKeys,
	onAbort,
	ref,
}: ChatInputProps) {
	const { t } = useTranslation();
	const [permissionMode, setPermissionMode] = useAtom(permissionModeAtomFamily(agentId));
	const [insertRequest, setInsertRequest] = useAtom(chatInputInsertRequestAtom);
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
			.catch((err) => console.warn("[ChatInput] getPermissionMode failed:", err));
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

	// ── slash / hash menus ──
	const menus = useChatInputMenus({ input, setInput });

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	useEffect(() => {
		if (!insertRequest || insertRequest.agentId !== agentId) return;
		const current = inputRef.current?.getText() ?? inputSnapshotRef.current;
		const separator = current.length > 0 && !/\s$/.test(current) ? " " : "";
		setInput(`${current}${separator}${insertRequest.text} `);
		inputRef.current?.focus();
		setInsertRequest(null);
	}, [agentId, insertRequest, setInput, setInsertRequest]);

	// ── image paste ──
	const handleImagesPasted = useCallback((images: ImageContent[]) => {
		setPendingImages((prev) => [...prev, ...images]);
	}, []);

	const handleRemoveImage = useCallback((index: number) => {
		setPendingImages((prev) => prev.filter((_, i) => i !== index));
	}, []);

	const hasContent = input.trim().length > 0 || pendingImages.length > 0;

	const handleSend = useCallback(
		async (sendMode?: "steer" | "followUp") => {
			const text = (inputRef.current?.getText() ?? "").trim();
			if (!text && pendingImages.length === 0) return;
			const images = pendingImages.length > 0 ? pendingImages : undefined;
			if (await onSend(text || "", images, sendMode)) {
				setInput("");
				setPendingImages([]);
			}
		},
		[onSend, pendingImages, setInput],
	);

	const handleAbort = useCallback(() => {
		onAbort?.();
	}, [onAbort]);

	const handleEditorChange = useCallback(
		(text: string) => {
			const prev = inputSnapshotRef.current;
			if (text !== prev) {
				undoStackRef.current.push(prev);
				if (undoStackRef.current.length > MAX_UNDO) {
					undoStackRef.current.shift();
				}
			}
			// Reset menu indices when a menu freshly opens.
			if (!/^\/[^\s]*$/.test(prev) && /^\/[^\s]*$/.test(text)) {
				menus.setSlashIndex(0);
			}
			const AGENT_TRIGGER_RE = /(?:\/(?:agent|subagent)|@):?[A-Za-z0-9._-]*$/;
			if (!AGENT_TRIGGER_RE.test(prev) && AGENT_TRIGGER_RE.test(text)) {
				menus.setAtIndex(0);
			}
			if (!/(?:^|\s)#[^\s]*$/.test(prev) && /(?:^|\s)#[^\s]*$/.test(text)) {
				menus.setMcpIndex(0);
			}
			setInputState(text);
		},
		[menus.setSlashIndex, menus.setAtIndex, menus.setMcpIndex],
	);

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
		// Delegate menu keyboard navigation to the hook.
		if (menus.handleMenuKeyDown(e)) return;

		if (e.key === "Enter" && !e.shiftKey && !(e.nativeEvent as KeyboardEvent).isComposing) {
			e.preventDefault();
			// Enter: steer (interrupt after current tool call when busy)
			// Ctrl+Enter: followUp (wait until agent finishes when busy)
			// Both: normal send when idle (sendMode ignored server-side)
			const sendMode = e.ctrlKey || e.metaKey ? "followUp" : "steer";
			void handleSend(sendMode);
		}
	};

	return (
		<div className="relative mx-5 mb-2.5 rounded-lg border border-hairline bg-background/30 shadow-none backdrop-blur-sm">
			{menus.atOpen ? (
				<AgentHashMenu
					agents={menus.filteredAgents}
					searchTerm={menus.atSearchTerm}
					selectedIndex={menus.atIndex}
					onSelectedIndexChange={menus.setAtIndex}
					onSelectAgent={(a) => {
						const replaced = input.replace(/(?:\/(?:agent|subagent)|@):?[A-Za-z0-9._-]*$/, `/agent:${a.name} `);
						setInput(replaced);
					}}
					onClose={() => {
						const cleaned = input.replace(/(?:\/(?:agent|subagent)|@):?[A-Za-z0-9._-]*$/, "").trimEnd();
						setInput(cleaned);
					}}
					subagentEnabled={menus.subagentOn}
				/>
			) : null}
			{menus.mcpOpen ? (
				<McpHashMenu
					tools={menus.filteredMcpTools}
					searchTerm={menus.mcpSearchTerm}
					selectedIndex={menus.mcpIndex}
					onSelectedIndexChange={menus.setMcpIndex}
					onSelectTool={(t) => {
						setInput(input.replace(/#[^\s]*$/, `#${t.server}__${t.toolName} `));
					}}
					onClose={() => {
						const cleaned = input.replace(/#[^\s]*$/, "").trimEnd();
						setInput(cleaned);
					}}
				/>
			) : null}
			{menus.slashOpen ? (
				<SkillSlashMenu
					skills={menus.filteredSkills}
					searchTerm={menus.slashSearchTerm}
					importedPaths={menus.importedPaths}
					detected={menus.detected}
					selectedIndex={menus.slashIndex}
					onSelectedIndexChange={menus.setSlashIndex}
					onSelectSkill={(s) => setInput(`/skill:${s.name} `)}
					onImportFrom={(d) => void menus.importDetected(d)}
					onImportRequest={() => {
						setInput("");
					}}
					onClose={() => setInput("")}
				/>
			) : null}

			<ImagePreviewBar pendingImages={pendingImages} onRemove={handleRemoveImage} />

			<ContentEditableInput
				ref={inputRef}
				placeholder={
					isBusy
						? `${t("chat.send")}… Enter ${t("chat.toSteer")} · Ctrl+Enter ${t("chat.toQueue")}`
						: `${t("chat.placeholder")}`
				}
				onChange={handleEditorChange}
				onImagesPasted={handleImagesPasted}
				onKeyDown={handleEditorKeyDown}
			/>
			<ChatInputToolbar
				agentId={agentId}
				currentModel={currentModel}
				currentThinking={currentThinking}
				availableThinkingLevels={availableThinkingLevels}
				permissionMode={permissionMode}
				isBusy={isBusy}
				isCompacting={isCompacting ?? false}
				hasContent={hasContent}
				onModelChange={onModelChange}
				onThinkingChange={onThinkingChange}
				onRequestApiKeys={onRequestApiKeys}
				onSend={() => handleSend("steer")}
				onAbort={handleAbort}
			/>
		</div>
	);
};

export default memo(ChatInput);
