// ============================================================
// useContentEditablePaste — 粘贴事件处理 hook
//
// 处理 contentEditable 中的粘贴事件：
//   1. 提取剪贴板中的图片文件 → onImagesPasted
//   2. 提取纯文本 → 插入光标位置 → 重建 DOM（chip 化）
// ============================================================

import type { ImageContent } from "@shared/types";
import { useCallback } from "react";
import { placeCaretAtEnd, renderToDOM } from "../components/chat/contentEditableUtils";

interface UseContentEditablePasteOptions {
	editorRef: React.RefObject<HTMLDivElement | null>;
	setEditorContent: React.Dispatch<React.SetStateAction<string>>;
	lastRenderedRef: React.MutableRefObject<string>;
	onChange: (text: string) => void;
	onImagesPasted?: (images: ImageContent[]) => void;
}

export function useContentEditablePaste({
	editorRef,
	setEditorContent,
	lastRenderedRef,
	onChange,
	onImagesPasted,
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
			if (!el) {
				setEditorContent(text);
				onChange(text);
				return;
			}
			const selection = window.getSelection();
			if (!selection || selection.rangeCount === 0) {
				el.appendChild(document.createTextNode(text));
			} else {
				const range = selection.getRangeAt(0);
				range.deleteContents();
				range.insertNode(document.createTextNode(text));
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
		},
		[editorRef, setEditorContent, lastRenderedRef, onChange, onImagesPasted],
	);
}
