// ============================================================
// useContentEditablePaste — 粘贴事件处理 hook
//
// 处理 contentEditable 中的粘贴事件：
//   1. 提取剪贴板中的图片文件 → onImagesPasted
//   2. 提取纯文本：
//      a. 大段文本（长度/行数/代码特征命中阈值）→ 自动转为附件文件
//         （attachment:create → onAttachmentCreated；失败回退为普通插入，不丢内容）
//      b. 其余 → 插入光标位置 → 重建 DOM（chip 化）
// ============================================================

import type { ImageContent, PendingAttachment } from "@shared/types";
import { useCallback } from "react";
import { toast } from "sonner";
import { placeCaretAtEnd, renderToDOM } from "../components/chat/contentEditableUtils";
import { buildAttachmentName, shouldConvertPasteToAttachment } from "../lib/pasteAttachment";

interface UseContentEditablePasteOptions {
	editorRef: React.RefObject<HTMLDivElement | null>;
	setEditorContent: React.Dispatch<React.SetStateAction<string>>;
	lastRenderedRef: React.MutableRefObject<string>;
	onChange: (text: string) => void;
	onImagesPasted?: (images: ImageContent[]) => void;
	/** 当前会话所属项目 id；为空时禁用自动转附件。 */
	projectId?: string | null;
	/** 当前会话 id。 */
	sessionId?: string | null;
	/** 大文本粘贴转附件成功后的回调（ChatInput 负责加入附件栏）。 */
	onAttachmentCreated?: (attachment: PendingAttachment) => void;
	/** 当前待发送附件数量，用于生成不重复的序号文件名。 */
	attachmentCount?: number;
}

export function useContentEditablePaste({
	editorRef,
	setEditorContent,
	lastRenderedRef,
	onChange,
	onImagesPasted,
	projectId,
	sessionId,
	onAttachmentCreated,
	attachmentCount,
}: UseContentEditablePasteOptions) {
	return useCallback(
		(e: React.ClipboardEvent<HTMLDivElement>) => {
			// ---- Image paste detection ----
			const items = e.clipboardData.items;
			const pastedImages: ImageContent[] = [];
			let imageFileCount = 0;
			if (items && onImagesPasted) {
				for (let i = 0; i < items.length; i++) {
					const item = items[i];
					if (item.kind !== "file") continue;
					const file = item.getAsFile();
					if (file && (file.type.startsWith("image/") || file.type === "")) {
						imageFileCount++;
					}
				}
				for (let i = 0; i < items.length; i++) {
					const item = items[i];
					if (item.kind !== "file") continue;
					const file = item.getAsFile();
					if (!file) continue;
					if (!file.type.startsWith("image/") && file.type !== "") continue;
					const mimeType = file.type || "image/png";
					const reader = new FileReader();
					reader.onload = () => {
						const dataUrl = reader.result as string;
						const comma = dataUrl.indexOf(",");
						const rawBase64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
						let resolvedType = mimeType;
						if (!file.type && comma >= 0) {
							const prefix = dataUrl.slice(0, comma);
							const m = prefix.match(/^data:(image\/\w+);/);
							if (m) resolvedType = m[1];
						}
						pastedImages.push({
							type: "image" as const,
							data: rawBase64,
							mimeType: resolvedType,
						});
						if (pastedImages.length === imageFileCount) {
							onImagesPasted(pastedImages);
						}
					};
					reader.readAsDataURL(file);
				}
			}

			// ---- Text paste ----
			e.preventDefault();
			const text = e.clipboardData.getData("text/plain");
			const el = editorRef.current;

			// 普通文本插入（粘贴内容进光标位置并重建 DOM）。转附件失败时也走这里回退。
			const insertText = (content: string) => {
				if (!el) {
					setEditorContent(content);
					onChange(content);
					return;
				}
				const selection = window.getSelection();
				if (!selection || selection.rangeCount === 0) {
					el.appendChild(document.createTextNode(content));
				} else {
					const range = selection.getRangeAt(0);
					range.deleteContents();
					range.insertNode(document.createTextNode(content));
					range.collapse(false);
					selection.removeAllRanges();
					selection.addRange(range);
				}
				const newText = el.textContent ?? "";
				renderToDOM(el, newText);
				placeCaretAtEnd(el);
				lastRenderedRef.current = newText;
				setEditorContent(newText);
				onChange(newText);
			};

			// 大段文本自动转附件（决策 D4）：不插入输入框，落盘后加入附件栏。
			const canConvert =
				text.length > 0 &&
				onAttachmentCreated !== undefined &&
				typeof projectId === "string" &&
				typeof sessionId === "string" &&
				shouldConvertPasteToAttachment(text);
			if (canConvert) {
				const name = buildAttachmentName(text, attachmentCount ?? 0);
				void (async () => {
					try {
						const result = await window.look.createAttachment(projectId, sessionId, name, text);
						if (!result?.success) {
							throw new Error(result?.error ?? "Failed to create attachment");
						}
						onAttachmentCreated(result.attachment);
					} catch (error) {
						// 创建失败：回退为普通粘贴，绝不丢内容
						insertText(text);
						toast.error(error instanceof Error ? error.message : "Failed to convert paste to attachment");
					}
				})();
				return;
			}

			insertText(text);
		},
		[
			editorRef,
			setEditorContent,
			lastRenderedRef,
			onChange,
			onImagesPasted,
			projectId,
			sessionId,
			onAttachmentCreated,
			attachmentCount,
		],
	);
}
