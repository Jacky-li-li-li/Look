// ============================================================
// StreamingMarkdown — Markdown renderer with Shiki syntax highlighting
// ============================================================

import { Button } from "@shared/components/ui/button";
import { cn } from "@shared/lib/utils";
import DOMPurify from "dompurify";

/**
 * Auto-close unclosed fenced code blocks (```) so ReactMarkdown
 * never receives partial fences during streaming.
 */
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

/**
 * Escape asterisks in file globs like `*.md` or `src/*.ts` so they are not
 * misinterpreted as Markdown emphasis markers. Only touches text outside
 * fenced code blocks (``` or ~~~) and indented code blocks (4+ spaces).
 */
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
		// Skip indented code blocks (4+ leading spaces).
		if (/^ {4,}/.test(line)) {
			result.push(line);
			continue;
		}
		result.push(line.replace(/(^|\s|[(/])(\*\.\S+)/g, "$1\\$2"));
	}
	return result.join("\n");
}

import { Check, Copy } from "lucide-react";
import type React from "react";
import { createContext, lazy, memo, Suspense, use, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useThrottle } from "../hooks/useThrottle";
import { getCachedHighlighter } from "../lib/highlighter";

const MermaidBlock = lazy(() => import("./MermaidBlock"));

/** Context so deeply-nested ShikiCodeBlock knows whether the parent is streaming. */
const StreamingContext = createContext(false);

interface StreamingMarkdownProps {
	content: string;
	isStreaming?: boolean;
	className?: string;
	/** When true, paragraphs render as <span> so content flows inline with siblings. */
	inline?: boolean;
}

// ============================================================
// ShikiCodeBlock — syntax-highlighted code block via Shiki
// ============================================================

const ShikiCodeBlock = memo(function ShikiCodeBlock({
	language,
	children,
}: {
	language: string;
	children: React.ReactNode;
}) {
	const isStreaming = use(StreamingContext);
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const code = String(children).replace(/\n$/, "");
	const lang = language || "text";

	// Synchronous highlight via useMemo — no useState + useEffect, reducing
	// hook profiling overhead in dev mode. Highlighter is preloaded at app
	// startup so getCachedHighlighter() is always non-null after first paint.
	const html = useMemo(() => {
		if (isStreaming) return null;
		const h = getCachedHighlighter();
		if (!h) return null;
		const safeLang = h.getLoadedLanguages().includes(lang) ? lang : "text";
		try {
			return h.codeToHtml(code, { lang: safeLang, theme: "github-dark" });
		} catch {
			return null;
		}
	}, [code, lang, isStreaming]);

	useEffect(() => () => clearTimeout(timerRef.current), []);

	const handleCopy = () => {
		navigator.clipboard.writeText(code);
		setCopied(true);
		clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => setCopied(false), 2000);
	};

	return (
		<div className="group relative my-2 rounded-lg border border-hairline bg-muted/30 overflow-hidden">
			<div className="flex items-center justify-between px-3 py-1.5 border-b border-hairline bg-muted/50">
				<span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">{lang}</span>
				<Button
					variant="ghost"
					size="icon"
					className="size-6 opacity-0 group-hover:opacity-100 transition-opacity"
					onClick={handleCopy}
					title="Copy code"
				>
					{copied ? <Check className="size-3 text-green-400" /> : <Copy className="size-3" />}
				</Button>
			</div>
			{html ? (
				// biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki output sanitized with DOMPurify before rendering.
				<div className="shiki-code-output" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />
			) : (
				<pre className="overflow-x-auto p-3 text-[12px] leading-relaxed font-mono">
					<code>{code}</code>
				</pre>
			)}
		</div>
	);
});

function InlineCode({ children, ...props }: any) {
	return (
		<code className="relative rounded bg-muted px-1.5 py-0.5 text-[12px] font-mono" {...props}>
			{children}
		</code>
	);
}

function Table({ children, ...props }: any) {
	return (
		<div className="my-2 overflow-x-auto rounded-lg border border-hairline">
			<table className="w-full text-xs" {...props}>
				{children}
			</table>
		</div>
	);
}

function Th({ children, ...props }: any) {
	return (
		<th
			className="border-b border-hairline bg-muted/50 px-3 py-2 text-left font-semibold text-muted-foreground"
			{...props}
		>
			{children}
		</th>
	);
}

function Td({ children, ...props }: any) {
	return (
		<td className="border-b border-hairline px-3 py-2" {...props}>
			{children}
		</td>
	);
}

// ============================================================
// Main component
// ============================================================

const remarkPlugins = [remarkGfm];

// ---- Pre-built component maps (zero per-instance allocation) ----
function BlockP({ children, ...props }: any) {
	return <p {...props}>{children}</p>;
}
function InlineP({ children, ...props }: any) {
	return <span {...props}>{children}</span>;
}
function CodeRenderer({ node, inline: isInline, className: cls, children, ...props }: any) {
	const match = /language-(\w+)/.exec(cls || "");
	if (!isInline && match) {
		const lang = match[1];
		if (lang === "mermaid") {
			return (
				<Suspense fallback={<div className="p-4 text-xs text-muted-foreground">Loading diagram…</div>}>
					<MermaidBlock>{children}</MermaidBlock>
				</Suspense>
			);
		}
		return <ShikiCodeBlock language={lang}>{children}</ShikiCodeBlock>;
	}
	return <InlineCode {...props}>{children}</InlineCode>;
}
function PreRenderer({ children }: any) {
	return <>{children}</>;
}
function MarkdownA({ children, href, ...props }: any) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className="text-blue-400 underline decoration-blue-400/30 hover:decoration-blue-400 transition-colors"
			{...props}
		>
			{children}
		</a>
	);
}
function MarkdownBlockquote({ children, ...props }: any) {
	return (
		<blockquote className="my-2 border-l-2 border-muted-foreground/20 pl-2.5 italic text-muted-foreground" {...props}>
			{children}
		</blockquote>
	);
}
function MarkdownHr() {
	// Render a thematic break as invisible spacing so sections still
	// breathe, but no visible divider line clutters the output.
	return <div className="my-2" />;
}
function MarkdownUl({ children, ...props }: any) {
	return (
		<ul className="my-2 ml-4 list-disc space-y-0.5" {...props}>
			{children}
		</ul>
	);
}
function MarkdownOl({ children, ...props }: any) {
	return (
		<ol className="my-2 ml-4 list-decimal space-y-0.5" {...props}>
			{children}
		</ol>
	);
}
function MarkdownH1({ children, ...props }: any) {
	return (
		<h1 className="mt-3 mb-1.5 text-lg font-bold" {...props}>
			{children}
		</h1>
	);
}
function MarkdownH2({ children, ...props }: any) {
	return (
		<h2 className="mt-2 mb-1 text-base font-semibold" {...props}>
			{children}
		</h2>
	);
}
function MarkdownH3({ children, ...props }: any) {
	return (
		<h3 className="mt-1.5 mb-0.5 text-sm font-semibold" {...props}>
			{children}
		</h3>
	);
}

function MarkdownImg({ src, alt, ...props }: any) {
	const [error, setError] = useState(false);
	if (!src || error) return null;
	return (
		<img
			src={src}
			alt={alt ?? ""}
			loading="lazy"
			className="max-h-96 max-w-full rounded-md border border-hairline object-contain my-2"
			onError={() => setError(true)}
			{...props}
		/>
	);
}

const COMPONENTS_BLOCK = {
	p: BlockP,
	code: CodeRenderer,
	pre: PreRenderer,
	table: Table,
	th: Th,
	td: Td,
	a: MarkdownA,
	blockquote: MarkdownBlockquote,
	hr: MarkdownHr,
	img: MarkdownImg,
	ul: MarkdownUl,
	ol: MarkdownOl,
	h1: MarkdownH1,
	h2: MarkdownH2,
	h3: MarkdownH3,
} as const;

const COMPONENTS_INLINE = { ...COMPONENTS_BLOCK, p: InlineP } as const;
const StreamingMarkdown = memo(function StreamingMarkdown({
	content,
	isStreaming = false,
	className,
	inline = false,
}: StreamingMarkdownProps) {
	const throttledContent = useThrottle(content, 16, isStreaming);

	// Pick the pre-built component map — zero allocation per instance.
	const components = inline ? COMPONENTS_INLINE : COMPONENTS_BLOCK;

	// No rehypePlugins needed — Shiki handles syntax highlighting directly in ShikiCodeBlock.

	if (!throttledContent) {
		return isStreaming ? <span className="inline-block w-2 h-4 bg-primary animate-pulse rounded-xs ml-0.5" /> : null;
	}

	const displayContent = escapeGlobAsterisks(autoCloseCodeFences(throttledContent));

	const markdown = (
		<StreamingContext.Provider value={isStreaming}>
			<ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
				{displayContent}
			</ReactMarkdown>
		</StreamingContext.Provider>
	);
	if (inline) {
		return <span className={cn("contents", className)}>{markdown}</span>;
	}

	return (
		<div
			className={cn(
				"prose-sm dark:prose-invert prose-headings:text-foreground prose-p:text-foreground prose-strong:text-foreground prose-li:text-foreground prose-td:text-foreground prose-th:text-foreground prose-blockquote:text-foreground prose-code:text-foreground",
				className,
			)}
		>
			{markdown}
		</div>
	);
});

export default StreamingMarkdown;
