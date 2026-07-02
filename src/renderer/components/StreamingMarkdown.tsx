// ============================================================
// StreamingMarkdown — Streaming-aware Markdown renderer
// ============================================================
// Replaced react-markdown + remark-gfm with marked.js (12-17x faster).
// Uses "stable prefix + streaming tail" strategy: completed paragraphs are
// memoized and never re-render; only the last incomplete paragraph updates.
// ============================================================

import { cn } from "@shared/lib/utils";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo, useMemo } from "react";
import { getCachedHighlighter } from "../lib/highlighter";

// ── String transforms ──

/** Auto-close unclosed fenced code blocks so marked never sees partial fences. */
function autoCloseCodeFences(text: string): string {
	let open = false;
	let i = 0;
	while (i < text.length) {
		const nl = text.indexOf("\n", i);
		const lineEnd = nl === -1 ? text.length : nl + 1;
		const lineLen = nl === -1 ? text.length - i : nl - i;
		if (lineLen >= 3) {
			const c0 = text.charCodeAt(i);
			const c1 = text.charCodeAt(i + 1);
			const c2 = text.charCodeAt(i + 2);
			if (c0 === 0x60 && c1 === 0x60 && c2 === 0x60) {
				open = !open;
			}
		}
		i = lineEnd;
	}
	return open ? `${text}\n\`\`\`` : text;
}

/** Escape asterisks in file globs like `*.md` so they aren't misinterpreted as emphasis. */
function escapeGlobAsterisks(text: string): string {
	const lines = text.split("\n");
	let inFence: string | null = null;
	const result: string[] = [];
	for (const line of lines) {
		const trimmed = line.trimStart();
		if (inFence) {
			if (trimmed.startsWith(inFence)) inFence = null;
			result.push(line);
			continue;
		}
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			inFence = trimmed.startsWith("```") ? "```" : "~~~";
			result.push(line);
			continue;
		}
		if (/^ {4,}/.test(line)) {
			result.push(line);
			continue;
		}
		result.push(line.replace(/(^|\s|[(/])(\*\.\S+)/g, "$1\\$2"));
	}
	return result.join("\n");
}

// ── Block splitting for incremental rendering ──

/**
 * Split markdown text at stable paragraph boundaries (\n\n).
 * Fenced code block interior blank lines are NOT treated as boundaries.
 * Returns all completed blocks plus the in-progress tail.
 */
function splitAtStableBoundaries(text: string): { stable: string[]; tail: string } {
	const blocks: string[] = [];
	let current = "";
	let inFence: string | null = null;
	const lines = text.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i]!.trimStart();
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			inFence = inFence ? null : trimmed.startsWith("```") ? "```" : "~~~";
		}
		current += (i > 0 ? "\n" : "") + lines[i];
		// \n\n outside a fenced block = paragraph boundary
		if (!inFence && i < lines.length - 1 && lines[i] === "" && lines[i + 1] !== "") {
			blocks.push(current);
			current = "";
		}
	}

	return { stable: blocks, tail: current };
}

// ── Stable key for memo ──

function hashKey(s: string, salt: number): string {
	let h = salt;
	for (let i = 0; i < Math.min(s.length, 80); i++) {
		h = ((h << 5) - h + s.charCodeAt(i)) | 0;
	}
	return `bk${h}`;
}

// ── Markdown → sanitized HTML ──

function renderMarkdownHtml(content: string): string {
	if (!content) return "";
	const preprocessed = escapeGlobAsterisks(autoCloseCodeFences(content));
	const raw = marked.parse(preprocessed) as string;
	return DOMPurify.sanitize(raw);
}

// ── Shiki code highlighting post-process ──

function highlightCodeBlocks(html: string): string {
	const highlighter = getCachedHighlighter();
	if (!highlighter) return html;

	return html.replace(
		/<pre><code class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/g,
		(_full: string, lang: string, code: string) => {
			const decoded = code
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&amp;/g, "&")
				.replace(/&quot;/g, '"')
				.replace(/&#39;/g, "'");
			try {
				const safeLang = highlighter.getLoadedLanguages().includes(lang) ? lang : "text";
				return highlighter.codeToHtml(decoded, { lang: safeLang, theme: "github-dark" });
			} catch {
				return _full;
			}
		},
	);
}

// ── Component maps and prose styles ──

const PROSE_STYLES =
	"prose-sm dark:prose-invert prose-headings:text-foreground prose-p:text-foreground prose-strong:text-foreground prose-li:text-foreground prose-td:text-foreground prose-th:text-foreground prose-blockquote:text-foreground prose-code:text-foreground";

// ════════════════════════════════════════════════════════════
// Completed blocks — rendered once, memo-frozen forever
// ════════════════════════════════════════════════════════════

const MemoizedMarkdownBlock = memo(function MemoizedMarkdownBlock({ content }: { content: string }) {
	const html = useMemo(() => highlightCodeBlocks(renderMarkdownHtml(content)), [content]);
	return <div className="markdown-block" dangerouslySetInnerHTML={{ __html: html }} />;
});

// ════════════════════════════════════════════════════════════
// Streaming tail — short, re-renders every token, O(1) cost
// ════════════════════════════════════════════════════════════

const StreamingTail = memo(function StreamingTail({ content }: { content: string }) {
	// Tail is always short (<500 chars) so marked.parse is <0.1ms.
	// No highlightCodeBlocks — code blocks in the tail are incomplete/unstyled.
	const html = useMemo(() => renderMarkdownHtml(content), [content]);
	return (
		<span className="streaming-tail">
			<span dangerouslySetInnerHTML={{ __html: html }} />
			<span className="streaming-cursor" />
		</span>
	);
});

// ════════════════════════════════════════════════════════════
// Static full render (non-streaming, e.g. persisted messages)
// ════════════════════════════════════════════════════════════

const StaticMarkdown = memo(function StaticMarkdown({
	content,
	className,
	inline,
}: {
	content: string;
	className?: string;
	inline: boolean;
}) {
	const html = useMemo(() => highlightCodeBlocks(renderMarkdownHtml(content)), [content]);

	if (inline) {
		return (
			<span
				className={cn("contents streaming-markdown-inline", className)}
				dangerouslySetInnerHTML={{ __html: html }}
			/>
		);
	}

	return (
		<div
			className={cn(PROSE_STYLES, className)}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
});

// ════════════════════════════════════════════════════════════
// Main component
// ════════════════════════════════════════════════════════════

interface StreamingMarkdownProps {
	content: string;
	isStreaming?: boolean;
	className?: string;
	/** When true, block elements render as inline so content flows with siblings. */
	inline?: boolean;
}

const StreamingMarkdown = memo(function StreamingMarkdown({
	content,
	isStreaming = false,
	className,
	inline = false,
}: StreamingMarkdownProps) {
	// ── Non-streaming: full static render ──
	if (!isStreaming) {
		return <StaticMarkdown content={content} className={className} inline={inline} />;
	}

	// ── Streaming: stable blocks + live tail ──
	const { stable, tail } = useMemo(() => splitAtStableBoundaries(content), [content]);

	if (!content) {
		return <span className="streaming-cursor" />;
	}

	const wrapperClass = inline
		? cn("contents streaming-markdown-inline", className)
		: cn(PROSE_STYLES, className);

	return (
		<div className={wrapperClass}>
			{stable.map((block, i) => (
				<MemoizedMarkdownBlock key={hashKey(block, i)} content={`${block}\n\n`} />
			))}
			<StreamingTail content={tail} />
		</div>
	);
});

export default StreamingMarkdown;
