// ============================================================
// ContentEditableInput — `<div contenteditable>` replacement
// for the chat input `<textarea>`. Same imperative handle
// (`getText` / `setText` / `focus`) so ChatMessageList,
// ChatPanel, etc. need zero changes.
//
// Why contenteditable (and not textarea + overlay):
//   The previous `SkillOverlaySegments` design had to keep
//   the overlay's character metrics 1:1 with the textarea so
//   the caret would sit "inside" the chip background. That
//   rule forbade border, padding, font-weight, icons —
//   everything that makes a chip look like a chip. With a
//   single contenteditable DOM, the chip and the caret are
//   in the same document, so padding / border / icons /
//   font-medium are all free.
//
// Rendering model:
//   - We never trust the DOM as the source of truth. Every
//     external mutation (`setText`) and every user gesture
//     (keypress, paste) flows through `parseSkillSegments`
//     to rebuild the editor from a plain-text string.
//   - `editorContent` (React state) is the source of truth.
//     It's mirrored into the DOM on mount, on `setText`, and
//     after every IME `compositionend` (so chips form only
//     once a final token is committed).
//   - During active composition (IME candidate window) we
//     skip DOM rebuilds to avoid flickering when `/` ends up
//     in the candidate.
// ============================================================

import type { ImageContent } from "@shared/types";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { parseSkillSegments } from "./skillSegments";

export interface ContentEditableInputHandle {
	getText: () => string;
	setText: (text: string) => void;
	focus: () => void;
}

interface ContentEditableInputProps {
	placeholder?: string;
	/** Called whenever the editor's plain-text content changes
	 *  via user input (typing, paste, delete). External `setText`
	 *  calls do NOT fire this — only user-driven edits do. */
	onChange: (text: string) => void;
	/** Called when one or more images are pasted from the clipboard.
	 *  The consumer (ChatInput) manages the image list and preview UI. */
	onImagesPasted?: (images: ImageContent[]) => void;
	/** Tab pressed while the editor is focused. */
	onTab?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
	/** All other keydowns (including Enter, ArrowUp/Down, Escape).
	 *  The consumer is responsible for `preventDefault` when it
	 *  consumes the event. */
	onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
	/** Extra className applied to the editor div. */
	className?: string;
	/** Minimum number of visible text rows. Default 2. */
	minRows?: number;
}

function renderToDOM(container: HTMLElement, content: string) {
	// textContent = "" is the fastest reset; using removeChild in a
	// loop would re-parent the contenteditable selection state and
	// break caret restoration when we refocus.
	container.textContent = "";
	const segments = parseSkillSegments(content);
	for (const seg of segments) {
		if (seg.kind === "text") {
			// Plain text node — preserves whitespace including
			// the trailing space we add after each chip.
			container.appendChild(document.createTextNode(seg.value));
			continue;
		}
		const chip = document.createElement("span");
		chip.setAttribute("data-skill-chip", "");
		chip.setAttribute("data-name", seg.name);
		chip.className = "skill-chip";
		chip.setAttribute("contenteditable", "false");
		chip.textContent = `/skill:${seg.name}`;
		container.appendChild(chip);
		// One space after each chip so the caret has somewhere
		// to land when the user arrows past the chip. Without
		// it, the caret jumps over the chip and lands on the
		// next chip's prefix with no editable character in
		// between.
		container.appendChild(document.createTextNode(" "));
	}
}

function placeCaretAtEnd(container: HTMLElement) {
	const range = document.createRange();
	range.selectNodeContents(container);
	range.collapse(false);
	const selection = window.getSelection();
	if (!selection) return;
	selection.removeAllRanges();
	selection.addRange(range);
}

export const ContentEditableInput = forwardRef<ContentEditableInputHandle, ContentEditableInputProps>(
	function ContentEditableInput(
		{ placeholder, onChange, onImagesPasted, onTab, onKeyDown, className, minRows = 2 },
		ref,
	) {
		const editorRef = useRef<HTMLDivElement>(null);
		const [editorContent, setEditorContent] = useState("");
		const isComposingRef = useRef(false);
		// Tracks the last value we wrote into the DOM so we can
		// skip re-renders that would clobber the user's caret.
		const lastRenderedRef = useRef("");

		// Mount: render initial (empty) state. Chromium inserts
		// a `<br>` into a freshly-created contenteditable on focus
		// in some versions — we proactively wipe it.
		useEffect(() => {
			const el = editorRef.current;
			if (!el) return;
			// Prefer `\n` over `<div>` for the Enter separator so
			// the editor behaves like a textarea for the rest of
			// the pipeline (textContent stays a single line, paste
			// handlers don't get blockified, getText returns
			// predictable strings).
			try {
				document.execCommand("defaultParagraphSeparator", false, "p");
			} catch {
				// execCommand is deprecated but still works in
				// Chromium for this specific flag; ignore failures.
			}
			// field-sizing-content lets the editor grow to fit
			// its content (Chrome 124+; Electron's bundled
			// Chromium satisfies this). We set it via
			// setProperty because React's style object doesn't
			// know about this experimental CSS property and
			// won't convert the camelCase identifier to the
			// kebab-case CSS name.
			el.style.setProperty("field-sizing-content", "min-content");
			renderToDOM(el, "");
			lastRenderedRef.current = "";
		}, []);

		// setText — external write (e.g. branch nav, fork, slash
		// menu pick). Bypasses onChange and re-renders the DOM
		// from the new plain-text payload. Idempotent: a no-op
		// when the payload equals the last value we wrote, so
		// repeated callers (React strict-mode double-invoke,
		// branch-nav + auto-focus race) don't churn the DOM
		// and clobber the user's caret / active IME.
		const setText = useCallback((text: string) => {
			const el = editorRef.current;
			if (!el) {
				setEditorContent(text);
				lastRenderedRef.current = text;
				return;
			}
			if (text === lastRenderedRef.current) return;
			setEditorContent(text);
			renderToDOM(el, text);
			placeCaretAtEnd(el);
			lastRenderedRef.current = text;
		}, []);

		useImperativeHandle(
			ref,
			() => ({
				getText: () => editorRef.current?.textContent ?? "",
				setText,
				focus: () => editorRef.current?.focus(),
			}),
			[setText],
		);

		// ---- Event handlers ----

		const handleInput = useCallback(() => {
			const el = editorRef.current;
			if (!el) return;
			const text = el.textContent ?? "";
			setEditorContent(text);
			lastRenderedRef.current = text;
			onChange(text);
		}, [onChange]);

		const handleCompositionStart = useCallback(() => {
			isComposingRef.current = true;
		}, []);

		const handleCompositionEnd = useCallback(() => {
			isComposingRef.current = false;
			// Re-snapshot textContent after composition commits;
			// the IME may have inserted characters our keystroke
			// handler didn't see.
			const el = editorRef.current;
			if (!el) return;
			const text = el.textContent ?? "";
			setEditorContent(text);
			lastRenderedRef.current = text;
			onChange(text);
		}, [onChange]);

		const handleKeyDown = useCallback(
			(e: React.KeyboardEvent<HTMLDivElement>) => {
				// IME candidate window: never intercept anything
				// while composition is active. The consumer's
				// onKeyDown gets the event in case it wants to
				// observe (it just shouldn't preventDefault).
				if (isComposingRef.current || (e.nativeEvent as KeyboardEvent).isComposing) {
					onKeyDown?.(e);
					return;
				}
				if (e.key === "Tab") {
					onTab?.(e);
					return;
				}
				// All other keys (Enter, ArrowUp/Down, Escape, …)
				// are forwarded to the consumer. The consumer
				// decides whether to preventDefault and what to
				// do — ChatInput routes Enter to handleSend and
				// the slash / hash menus, for example.
				onKeyDown?.(e);
			},
			[onKeyDown, onTab],
		);

		const handlePaste = useCallback(
			(e: React.ClipboardEvent<HTMLDivElement>) => {
				// ---- Image paste detection ----
				// Check clipboard items for image data BEFORE
				// extracting plain text, because the browser may
				// include both an image file and a text/plain
				// fallback in the same event.
				//
				// On macOS + Electron, `DataTransferItem.type` is
				// often empty for clipboard images because Cocoa's
				// UTIs (public.png, public.tiff) don't always map
				// to standard MIME types. We use `File.type` instead,
				// which reads the blob header and is more reliable.
				const items = e.clipboardData.items;
				const pastedImages: ImageContent[] = [];
				let imageFileCount = 0;
				if (items && onImagesPasted) {
					// Count image items FIRST (before async readers),
					// then read each one. The onload callback uses the
					// count to know when all readers have finished.
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
						// Accept known image MIME types, or empty type
						// (macOS clipboard quirk — we fall back to the
						// data URL prefix to detect the real format).
						if (!file.type.startsWith("image/") && file.type !== "") continue;
						const mimeType = file.type || "image/png";
						const reader = new FileReader();
						reader.onload = () => {
							const dataUrl = reader.result as string;
							// "data:image/png;base64,iVBORw0KGgo…"
							const comma = dataUrl.indexOf(",");
							const rawBase64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
							// If the blob didn't have a MIME, extract
							// it from the data URL ("data:image/png;…").
							let resolvedType = mimeType;
							if (!file.type && comma >= 0) {
								const prefix = dataUrl.slice(0, comma); // "data:image/png;base64"
								const m = prefix.match(/^data:(image\/\w+);/);
								if (m) resolvedType = m[1];
							}
							pastedImages.push({
								type: "image" as const,
								data: rawBase64,
								mimeType: resolvedType,
							});
							// Fire callback once all readers done.
							if (pastedImages.length === imageFileCount) {
								onImagesPasted(pastedImages);
							}
						};
						reader.readAsDataURL(file);
					}
				}

				// ---- Text paste (existing logic) ----
				// Always sanitize to plain text. Pasting a `/skill:foo`
				// snippet should flow through `parseSkillSegments` so
				// it becomes a chip. Pasting HTML (e.g. from a
				// doc-copy) would otherwise dump `<div>`/`<span>`
				// nodes into the editor.
				e.preventDefault();
				const text = e.clipboardData.getData("text/plain");
				const el = editorRef.current;
				if (!el) {
					setEditorContent(text);
					onChange(text);
					return;
				}
				// Insert at caret using a text node so we keep
				// the existing selection state.
				const selection = window.getSelection();
				if (!selection || selection.rangeCount === 0) {
					// No active selection — append to end.
					el.appendChild(document.createTextNode(text));
				} else {
					const range = selection.getRangeAt(0);
					range.deleteContents();
					range.insertNode(document.createTextNode(text));
					// Move caret to the end of the inserted text.
					range.collapse(false);
					selection.removeAllRanges();
					selection.addRange(range);
				}
				// Now re-render the whole editor so the pasted
				// `/skill:foo` (if any) becomes a chip. We can't
				// just patch the inserted text node — chips need
				// the data-skill-chip span wrapper.
				const newText = el.textContent ?? "";
				renderToDOM(el, newText);
				placeCaretAtEnd(el);
				lastRenderedRef.current = newText;
				setEditorContent(newText);
				onChange(newText);
			},
			[onChange, onImagesPasted],
		);

		/**
		 * 拖拽接收 WorkspaceTreePanel 的文件/文件夹。
		 * 自定义 MIME `application/x-look-filerelpath` 携带相对路径,
		 * 转换为 `@relative-path` 文本插入到光标位置。
		 *
		 * 关键:无论 MIME 是否匹配都要 `preventDefault`,否则浏览器默认行为
		 * 会把外部拖入的文件(Finder / VSCode 等)直接插入到 contenteditable
		 * 里,破坏 React state 与文档结构。
		 */
		const handleDrop = useCallback(
			(e: React.DragEvent<HTMLDivElement>) => {
				// 始终阻止默认行为,防止外部文件污染编辑器
				e.preventDefault();
				const relPath = e.dataTransfer.getData("application/x-look-filerelpath");
				if (!relPath) return; // 不是工作区拖拽,已经 preventDefault 不会污染,只忽略
				const text = `@${relPath}`;
				const el = editorRef.current;
				if (!el) {
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
				el.focus();
			},
			[onChange],
		);

		const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
			// 仅当携带工作区 MIME 时显示 drop effect
			if (e.dataTransfer.types.includes("application/x-look-filerelpath")) {
				e.preventDefault();
				e.dataTransfer.dropEffect = "copy";
			}
		}, []);

		const handleFocus = useCallback(() => {
			// Some Chromium versions inject a stray `<br>` into
			// an empty contenteditable on focus. Strip it so the
			// placeholder can show through and the line-height
			// stays consistent with the textarea baseline.
			const el = editorRef.current;
			if (!el) return;
			if (el.innerHTML === "<br>" || el.innerHTML === "<div><br></div>") {
				el.innerHTML = "";
			}
		}, []);

		const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
			// Clicking a chip — single-click selects the
			// whole chip range so Backspace deletes it as
			// one token. The chip is contenteditable=false
			// so the caret can't land *inside* it; selecting
			// the surrounding range is the cleanest UX.
			const target = e.target as HTMLElement;
			if (target.dataset.skillChip !== undefined) {
				const el = editorRef.current;
				if (!el) return;
				const range = document.createRange();
				range.selectNode(target);
				const selection = window.getSelection();
				if (selection) {
					selection.removeAllRanges();
					selection.addRange(range);
				}
			}
		}, []);

		const showPlaceholder = editorContent.length === 0;

		return (
			<div className="relative w-full">
				{showPlaceholder && placeholder ? (
					<div
						aria-hidden
						className="pointer-events-none absolute top-0 left-0 select-none px-3 py-2.5 text-[13px] leading-relaxed text-muted-foreground/50"
					>
						{placeholder}
					</div>
				) : null}
				<div
					ref={editorRef}
					role="textbox"
					aria-multiline="true"
					aria-label="chat input"
					contentEditable
					suppressContentEditableWarning
					spellCheck={false}
					onInput={handleInput}
					onKeyDown={handleKeyDown}
					onPaste={handlePaste}
					onDrop={handleDrop}
					onDragOver={handleDragOver}
					onCompositionStart={handleCompositionStart}
					onCompositionEnd={handleCompositionEnd}
					onFocus={handleFocus}
					onClick={handleClick}
					className={[
						"min-h-16 w-full resize-none overflow-y-auto break-words whitespace-pre-wrap bg-transparent px-3 py-2.5 text-[13px] leading-relaxed",
						"focus:outline-none",
						className ?? "",
					]
						.filter(Boolean)
						.join(" ")}
					style={{
						minHeight: `${minRows * 1.625}rem`,
						maxHeight: "16rem",
					}}
				/>
			</div>
		);
	},
);

export default ContentEditableInput;

// Re-export the placeCaretAtEnd helper in case future code
// wants to programmatically focus + position the caret.
export { placeCaretAtEnd };
