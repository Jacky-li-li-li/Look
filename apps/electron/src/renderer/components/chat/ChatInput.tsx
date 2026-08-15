// ============================================================
// ChatInput — ContentEditableInput + Skill Slash Menu + Toolbar
//            (Ink Wash)
// ============================================================

import type { ImageContent, PendingAttachment, ThinkingLevel } from "@shared/types";
import { useAtom, useAtomValue } from "jotai";
import type React from "react";
import { memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useChatInputMenus } from "../../hooks/useChatInputMenus";
import { buildAttachmentName, sanitizeAttachmentName } from "../../lib/pasteAttachment";
import { appStore } from "../../store/appStore";
import {
	activeAgentAtom,
	chatInputInsertRequestAtom,
	confirmDockFileSwapIfDirty,
	dockedFileAtom,
	fileViewerDirtyAtom,
	permissionModeAtomFamily,
} from "../../store/atoms";
import ChatInputToolbar from "./ChatInputToolbar";
import ContentEditableInput, { type ContentEditableInputHandle } from "./ContentEditableInput";
import ImagePreviewBar from "./ImagePreviewBar";
import PendingAttachmentBar from "./PendingAttachmentBar";
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
	onSend: (
		text: string,
		images?: ImageContent[],
		attachments?: PendingAttachment[],
		sendMode?: "steer" | "followUp",
	) => Promise<boolean>;
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
	// Pending attachments — 大段粘贴自动转成的附件文件，随消息发送。
	const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
	// Whether a workspace file is currently being dragged over the input box.
	const [dragActive, setDragActive] = useState(false);
	// 拖拽类型：workspace（@path 引用）| external（外部文件转附件）——决定悬停提示。
	const [dragKind, setDragKind] = useState<"workspace" | "external" | null>(null);
	// 拖拽文件序号（sanitize 兜底命名用，避免并发同分钟内撞名）。
	const droppedSeqRef = useRef(0);
	// 当前会话所属项目（粘贴/拖拽转附件需要 projectId + sessionId 定位附件目录）。
	const activeAgent = useAtomValue(activeAgentAtom);
	const projectId = activeAgent?.projectId ?? null;

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

	// ── paste attachments ──
	const handleAttachmentCreated = useCallback(
		(attachment: PendingAttachment) => {
			setPendingAttachments((prev) => [...prev, attachment]);
			toast.success(t("chat.attachmentConvertedToast", { name: attachment.name }));
		},
		[t],
	);

	/** 点击附件卡片/编辑 → Dock 面板打开查看器（附件模式，预览/编辑共用入口）。 */
	const handleViewAttachment = useCallback((attachment: PendingAttachment) => {
		if (appStore.get(dockedFileAtom) && !confirmDockFileSwapIfDirty(() => appStore.get(fileViewerDirtyAtom))) {
			return;
		}
		appStore.set(dockedFileAtom, {
			absolutePath: attachment.path,
			attachment: {
				projectId: attachment.projectId,
				sessionId: attachment.sessionId,
				name: attachment.name,
			},
		});
	}, []);

	/** 还原为文本：读回磁盘内容填回输入框，并删除附件文件。 */
	const handleRestoreAttachment = useCallback(
		async (attachment: PendingAttachment) => {
			try {
				const result = await window.look.readAttachment(
					attachment.projectId,
					attachment.sessionId,
					attachment.name,
				);
				if (!result?.success) throw new Error(result?.error ?? "Failed to read attachment");
				const current = inputRef.current?.getText() ?? inputSnapshotRef.current;
				const separator = current.length > 0 && !/\s$/.test(current) ? "\n\n" : "";
				setInput(`${current}${separator}${result.content}`);
			} catch (error) {
				toast.error(error instanceof Error ? error.message : t("chat.attachmentRestoreFailed", { message: "" }));
				return;
			}
			await window.look.deleteAttachment(attachment.projectId, attachment.sessionId, attachment.name);
			setPendingAttachments((prev) => prev.filter((item) => item !== attachment));
		},
		[setInput, t],
	);

	/** 移除：仅删除附件文件与卡片（内容不保留）。 */
	const handleRemoveAttachment = useCallback(async (attachment: PendingAttachment) => {
		await window.look.deleteAttachment(attachment.projectId, attachment.sessionId, attachment.name);
		setPendingAttachments((prev) => prev.filter((item) => item !== attachment));
	}, []);

	// ── 外部文件拖拽（Finder/VSCode 等）：图片进图片栏，文本转附件 ──
	const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

	const readDroppedFileAsText = useCallback((file: File): Promise<string> => {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result ?? ""));
			reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
			reader.readAsText(file);
		});
	}, []);

	const handleDragActiveChange = useCallback((active: boolean, kind?: "workspace" | "external") => {
		setDragActive(active);
		setDragKind(kind ?? null);
	}, []);

	const ingestDroppedFile = useCallback(
		async (file: File) => {
			// 目录条目（webkitGetAsEntry 标记）或超过上限的大文件直接拒绝。
			const entry = (file as File & { webkitGetAsEntry?: () => { isDirectory?: boolean } }).webkitGetAsEntry?.();
			if (entry?.isDirectory) return;
			if (file.size > MAX_ATTACHMENT_BYTES) {
				toast.error(t("chat.attachmentTooLarge"));
				return;
			}
			// 图片文件走现有图片通道（缩略图栏，与剪贴板粘贴一致）。
			if (file.type.startsWith("image/")) {
				const reader = new FileReader();
				reader.onload = () => {
					const dataUrl = reader.result as string;
					const comma = dataUrl.indexOf(",");
					const rawBase64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
					setPendingImages((prev) => [
						...prev,
						{ type: "image", data: rawBase64, mimeType: file.type || "image/png" },
					]);
				};
				reader.readAsDataURL(file);
				return;
			}
			try {
				const content = await readDroppedFileAsText(file);
				const name = sanitizeAttachmentName(file.name) ?? buildAttachmentName(content, ++droppedSeqRef.current);
				if (!projectId) return;
				const result = await window.look.createAttachment(projectId, agentId, name, content);
				if (!result?.success) throw new Error(result?.error ?? "Failed to create attachment");
				handleAttachmentCreated(result.attachment);
			} catch (error) {
				toast.error(error instanceof Error ? error.message : t("chat.attachmentTooLarge"));
			}
		},
		[projectId, agentId, readDroppedFileAsText, handleAttachmentCreated, t],
	);

	const handleFilesDropped = useCallback(
		(files: File[]) => {
			if (files.length === 0) return;
			for (const file of files) void ingestDroppedFile(file);
		},
		[ingestDroppedFile],
	);

	// Tool 面板选中工具 → 追加引用 token 到输入框末尾（复用 insertRequest 机制）
	const handleInsertToken = useCallback(
		(token: string) => {
			setInsertRequest({ id: Date.now(), agentId, text: token });
		},
		[agentId, setInsertRequest],
	);

	const hasContent = input.trim().length > 0 || pendingImages.length > 0 || pendingAttachments.length > 0;

	const handleSend = useCallback(
		async (sendMode?: "steer" | "followUp") => {
			const text = (inputRef.current?.getText() ?? "").trim();
			if (!text && pendingImages.length === 0 && pendingAttachments.length === 0) return;
			const images = pendingImages.length > 0 ? pendingImages : undefined;
			const attachments = pendingAttachments.length > 0 ? pendingAttachments : undefined;
			if (await onSend(text || "", images, attachments, sendMode)) {
				setInput("");
				setPendingImages([]);
				setPendingAttachments([]);
			}
		},
		[onSend, pendingImages, pendingAttachments, setInput],
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
			setInputState(text);
		},
		[menus.setSlashIndex],
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

	const placeholder = pendingAttachments.length > 0 ? t("chat.attachmentPlaceholder") : undefined;

	return (
		<div
			className={[
				"relative mx-5 mb-2.5 rounded-lg border bg-background/30 shadow-none backdrop-blur-sm transition-all",
				dragActive ? "border-foreground/60 bg-foreground/[0.04] ring-2 ring-foreground/30" : "border-hairline",
			].join(" ")}
		>
			{/* 拖拽悬停提示 */}
			{dragActive ? (
				<div className="pointer-events-none absolute -top-3.5 left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-full border border-hairline bg-card/95 px-2.5 py-0.5 text-[10px] text-foreground shadow-sm backdrop-blur">
					{dragKind === "external" ? t("chat.dropFileHintAttachment") : t("chat.dropFileHint", "松手插入文件引用")}
				</div>
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

			<PendingAttachmentBar
				attachments={pendingAttachments}
				onView={handleViewAttachment}
				onRestore={handleRestoreAttachment}
				onRemove={handleRemoveAttachment}
			/>
			<ImagePreviewBar pendingImages={pendingImages} onRemove={handleRemoveImage} />

			<ContentEditableInput
				ref={inputRef}
				placeholder={
					placeholder ??
					(isBusy
						? `${t("chat.send")}… Enter ${t("chat.toSteer")} · Ctrl+Enter ${t("chat.toQueue")}`
						: `${t("chat.placeholder")}`)
				}
				onChange={handleEditorChange}
				onImagesPasted={handleImagesPasted}
				projectId={projectId}
				sessionId={agentId}
				onAttachmentCreated={handleAttachmentCreated}
				attachmentCount={pendingAttachments.length + 1}
				onKeyDown={handleEditorKeyDown}
				onDragActiveChange={handleDragActiveChange}
				onFilesDropped={handleFilesDropped}
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
				toolData={{
					skills: menus.pickableSkills,
					agents: menus.pickableAgents,
					mcpTools: menus.mcpTools,
				}}
				onInsertToken={handleInsertToken}
			/>
		</div>
	);
};

export default memo(ChatInput);
