// ============================================================
// LookMarkdown — stable chat Markdown adapter built on Streamdown
// ============================================================

import { cn } from "@look/ui";
import { cjk } from "@streamdown/cjk";
import { createCodePlugin } from "@streamdown/code";
import type { DiagramPlugin, MermaidConfig } from "@streamdown/mermaid";
import { memo, useEffect, useMemo, useState } from "react";
import { type AnimateOptions, defaultRemarkPlugins, Streamdown } from "streamdown";
import { useLookTheme } from "../../hooks/useLookTheme";
import { prepareMessageContent } from "../../lib/messageMarkdown";
import { remarkLookReferences } from "../../lib/remarkLookReferences";
import { AsciiDiagram } from "./AsciiDiagram";
import { lookMarkdownComponents } from "./lookMarkdownComponents";

export interface LookMarkdownProps {
	content: string;
	isStreaming?: boolean;
	/** Docs mode keeps a slightly more relaxed long-form reading rhythm. */
	docs?: boolean;
}

const codePlugin = createCodePlugin({
	themes: ["github-light", "github-dark"],
});

const customRenderers = [{ language: "ascii", component: AsciiDiagram }];
const basePlugins = { code: codePlugin, cjk, renderers: customRenderers } as const;
const STREAMING_TEXT_ANIMATION = {
	animation: "look-text-reveal",
	duration: 300,
	easing: "cubic-bezier(0, 0, 0.2, 1)",
	sep: "word",
	stagger: 0,
} satisfies AnimateOptions;
const MERMAID_FENCE_RE = /(?:^|\n)[\t ]{0,3}(?:`{3,}|~{3,})[\t ]*mermaid\b/i;
const allowedTags = {
	"skill-tag": ["data*"],
	"agent-tag": ["data*"],
	"mcp-tag": ["data*"],
	"file-tag": ["data*"],
};
const literalTagContent = ["skill-tag", "agent-tag", "mcp-tag", "file-tag"];
const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkLookReferences];

const LookMarkdown = memo(function LookMarkdown({ content, isStreaming = false, docs = false }: LookMarkdownProps) {
	const { tone } = useLookTheme();
	const prepared = useMemo(() => prepareMessageContent(content), [content]);
	const needsMermaid = useMemo(() => MERMAID_FENCE_RE.test(prepared), [prepared]);
	const [diagramPlugin, setDiagramPlugin] = useState<DiagramPlugin | null>(null);

	useEffect(() => {
		if (!needsMermaid || diagramPlugin) return;
		let cancelled = false;
		void import("@streamdown/mermaid")
			.then(({ mermaid }) => {
				if (!cancelled) setDiagramPlugin(mermaid);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [diagramPlugin, needsMermaid]);

	const plugins = useMemo(
		() => (diagramPlugin ? { ...basePlugins, mermaid: diagramPlugin } : basePlugins),
		[diagramPlugin],
	);
	const mermaidConfig = useMemo<MermaidConfig>(
		() => ({
			theme: tone === "dark" ? "dark" : "neutral",
			securityLevel: "strict",
			fontFamily: '"Geist Variable", system-ui, sans-serif',
		}),
		[tone],
	);

	return (
		<Streamdown
			className={cn(
				"look-markdown space-y-0",
				docs ? "look-markdown--docs" : "look-markdown--chat",
				isStreaming && !docs && "look-markdown--streaming",
			)}
			mode={docs ? "static" : "streaming"}
			parseIncompleteMarkdown={isStreaming}
			isAnimating={isStreaming}
			animated={STREAMING_TEXT_ANIMATION}
			plugins={plugins}
			mermaid={{ config: mermaidConfig }}
			remarkPlugins={remarkPlugins}
			components={lookMarkdownComponents}
			allowedTags={allowedTags}
			literalTagContent={literalTagContent}
			shikiTheme={["github-light", "github-dark"]}
			lineNumbers={false}
			controls={{
				code: { copy: true, download: false },
				table: false,
				mermaid: false,
			}}
		>
			{prepared}
		</Streamdown>
	);
});

export default LookMarkdown;
