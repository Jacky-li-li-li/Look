// ============================================================
// StreamingMarkdown — Markdown renderer with stream-friendly throttling
// ============================================================

import React, { useMemo, useRef, useEffect, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cn } from "@shared/lib/utils";
import { useThrottle } from "../hooks/useThrottle";
import { Copy, Check } from "lucide-react";
import { Button } from "@shared/components/ui/button";

interface StreamingMarkdownProps {
  content: string;
  isStreaming?: boolean;
  className?: string;
}

// ============================================================
// Custom components
// ============================================================

function CodeBlock({ language, children, ...props }: any) {
  const [copied, setCopied] = React.useState(false);
  const code = String(children).replace(/\n$/, "");
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group relative my-3 rounded-lg border bg-muted/30 overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/50">
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
          {language || "text"}
        </span>
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
      {/* Code */}
      <pre className="overflow-x-auto p-3 text-[12px] leading-relaxed font-mono">
        <code className={`language-${language || "text"}`}>{code}</code>
      </pre>
    </div>
  );
}

function InlineCode({ children, ...props }: any) {
  return (
    <code className="relative rounded bg-muted px-1.5 py-0.5 text-[12px] font-mono" {...props}>
      {children}
    </code>
  );
}

function Table({ children, ...props }: any) {
  return (
    <div className="my-3 overflow-x-auto rounded-lg border">
      <table className="w-full text-xs" {...props}>
        {children}
      </table>
    </div>
  );
}

function Th({ children, ...props }: any) {
  return (
    <th className="border-b bg-muted/50 px-3 py-2 text-left font-semibold text-muted-foreground" {...props}>
      {children}
    </th>
  );
}

function Td({ children, ...props }: any) {
  return (
    <td className="border-b px-3 py-2" {...props}>
      {children}
    </td>
  );
}

// ============================================================
// Main component
// ============================================================

const StreamingMarkdown = memo(function StreamingMarkdown({
  content,
  isStreaming = false,
  className,
}: StreamingMarkdownProps) {
  // Throttle content during streaming to avoid re-parsing on every token
  const throttledContent = useThrottle(content, 80, isStreaming);

  // Memo components to avoid recreating on each render
  const components = useMemo(() => ({
    code({ node, inline, className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || "");
      if (!inline && match) {
        return <CodeBlock language={match[1]} {...props}>{children}</CodeBlock>;
      }
      return <InlineCode {...props}>{children}</InlineCode>;
    },
    pre({ children }: any) {
      // ReactMarkdown wraps code in pre — pass through for our custom CodeBlock
      return <>{children}</>;
    },
    table: Table,
    th: Th,
    td: Td,
    // Style links
    a({ children, href, ...props }: any) {
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
    },
    // Style blockquotes
    blockquote({ children, ...props }: any) {
      return (
        <blockquote className="my-2 border-l-2 border-muted-foreground/30 pl-3 italic text-muted-foreground" {...props}>
          {children}
        </blockquote>
      );
    },
    // Horizontal rule
    hr(props: any) {
      return <hr className="my-4 border-border" {...props} />;
    },
    // Lists
    ul({ children, ...props }: any) {
      return <ul className="my-2 ml-4 list-disc space-y-1" {...props}>{children}</ul>;
    },
    ol({ children, ...props }: any) {
      return <ol className="my-2 ml-4 list-decimal space-y-1" {...props}>{children}</ol>;
    },
    // Headings
    h1({ children, ...props }: any) {
      return <h1 className="mt-4 mb-2 text-lg font-bold" {...props}>{children}</h1>;
    },
    h2({ children, ...props }: any) {
      return <h2 className="mt-3 mb-1.5 text-base font-semibold" {...props}>{children}</h2>;
    },
    h3({ children, ...props }: any) {
      return <h3 className="mt-2 mb-1 text-sm font-semibold" {...props}>{children}</h3>;
    },
  }), []);

  // Memoize plugin arrays to avoid unnecessary ReactMarkdown re-renders
  const remarkPlugins = useMemo(() => [remarkGfm], []);
  const rehypePlugins = useMemo(() => [rehypeHighlight], []);

  // If empty, show nothing
  if (!throttledContent) {
    return isStreaming ? (
      <span className="inline-block w-2 h-4 bg-primary animate-pulse rounded-xs ml-0.5" />
    ) : null;
  }

  return (
    <div className={cn("prose-sm prose-headings:text-foreground prose-p:text-foreground prose-strong:text-foreground", className)}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {throttledContent}
      </ReactMarkdown>
    </div>
  );
});

export default StreamingMarkdown;
