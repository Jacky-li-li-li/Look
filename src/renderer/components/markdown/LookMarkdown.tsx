// ============================================================
// LookMarkdown — Look-themed wrapper around markstream-react
// ============================================================

import { AgentTag } from "@shared/components/AgentTag";
import { FileTag } from "@shared/components/FileTag";
import { McpTag } from "@shared/components/McpTag";
import { SkillTag } from "@shared/components/SkillTag";
import type { MarkdownCodeBlockNodeProps } from "markstream-react";
import MarkdownRender, {
	defineStreamingComponents,
	MarkdownCodeBlockNode,
	type NodeComponentProps,
	setCustomComponents,
} from "markstream-react";
import { memo, useMemo } from "react";
import { useLookTheme } from "../../hooks/useLookTheme";
import { closeAtxHeadings, prepareMessageContent } from "../../lib/messageMarkdown";

// ── Built-in code blocks: lightweight Shiki instead of Monaco ──

function ShikiCodeBlock({ node, isDark, ctx }: NodeComponentProps<MarkdownCodeBlockNodeProps["node"]>) {
	return (
		<MarkdownCodeBlockNode
			node={node}
			isDark={isDark}
			stream={ctx?.codeBlockStream ?? true}
			themes={["github-dark", "github-light"]}
			darkTheme="github-dark"
			lightTheme="github-light"
			langs={CODE_LANGS}
			showHeader={false}
		/>
	);
}

setCustomComponents({ code_block: ShikiCodeBlock });

// ── Custom HTML-like tags for skill/agent chips ──

interface ChipNode {
	type: string;
	tag?: string;
	content: string;
	attrs?: unknown;
}

function getAttr(node: ChipNode, name: string): string | undefined {
	const attrs = node.attrs;
	if (!attrs) return undefined;
	if (Array.isArray(attrs)) {
		for (const item of attrs) {
			if (Array.isArray(item) && item[0] === name) return item[1];
			if (typeof item === "object" && item !== null && "name" in item && item.name === name)
				return String(item.value);
		}
		return undefined;
	}
	const value = (attrs as Record<string, string | boolean>)[name];
	return value === undefined ? undefined : String(value);
}

function SkillTagNode({ node }: NodeComponentProps<ChipNode>) {
	const name = getAttr(node, "name") || node.content;
	if (!name) return null;
	return <SkillTag name={name} />;
}

function AgentTagNode({ node }: NodeComponentProps<ChipNode>) {
	const name = getAttr(node, "name") || node.content;
	if (!name) return null;
	return <AgentTag name={name} />;
}

function McpTagNode({ node }: NodeComponentProps<ChipNode>) {
	const server = getAttr(node, "server") || "";
	const tool = getAttr(node, "tool") || "";
	if (!server || !tool) return null;
	return <McpTag server={server} toolName={tool} />;
}

function FileTagNode({ node }: NodeComponentProps<ChipNode>) {
	const path = getAttr(node, "path") || node.content;
	if (!path) return null;
	return <FileTag path={path} />;
}

const streamingComponents = defineStreamingComponents({
	"skill-tag": SkillTagNode,
	"agent-tag": AgentTagNode,
	"mcp-tag": McpTagNode,
	"file-tag": FileTagNode,
});

// ── Component ──

export interface LookMarkdownProps {
	content: string;
	isStreaming?: boolean;
	/** Docs mode for long-form static Markdown (e.g. plan approval). */
	docs?: boolean;
}

const CODE_LANGS = [
	"typescript",
	"javascript",
	"tsx",
	"jsx",
	"python",
	"bash",
	"shell",
	"sh",
	"json",
	"yaml",
	"markdown",
	"css",
	"html",
	"xml",
	"rust",
	"go",
	"sql",
	"c",
	"cpp",
	"java",
	"ruby",
	"php",
	"swift",
	"kotlin",
	"text",
];

const STREAMING_MARKDOWN_SMOOTH_OPTIONS = {
	// ── 瀑布流式行级展开 ──
	// 每帧交付一整行甚至一整段（~800-1200 字符），
	// 而非逐字吐出，配合 CSS 曲线动画实现逐行瀑布效果。
	minCharsPerSecond: 2000,
	maxCharsPerSecond: 12000,
	targetLatencyMs: 40,
	catchUpLatencyMs: 20,
	catchUpThreshold: 120,
	maxCommitFps: 30,
	startDelayMs: 0,
	maxCharsPerCommit: 1200,
	flushOnFinish: true,
};

const LookMarkdown = memo(function LookMarkdown({ content, isStreaming = false, docs = false }: LookMarkdownProps) {
	const { tone } = useLookTheme();
	const prepared = useMemo(() => {
		const raw = prepareMessageContent(content);
		// Work around a markstream-react 0.0.53 parser bug where an H1 followed
		// by a paragraph containing bold emphasis is merged into one heading.
		return closeAtxHeadings(raw);
	}, [content]);

	return (
		<MarkdownRender
			customId="look-message"
			content={prepared}
			final={!isStreaming}
			fade={isStreaming ? false : !docs}
			smoothStreaming={isStreaming}
			smoothStreamingOptions={STREAMING_MARKDOWN_SMOOTH_OPTIONS}
			batchRendering={isStreaming}
			isDark={tone === "dark"}
			streamingComponents={streamingComponents}
			customHtmlTags={["skill-tag", "agent-tag", "mcp-tag", "file-tag"]}
			htmlPolicy="safe"
			deferNodesUntilVisible={isStreaming}
		/>
	);
});

export default LookMarkdown;
