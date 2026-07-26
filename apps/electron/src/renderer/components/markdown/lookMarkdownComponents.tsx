import { cn } from "@look/ui";
import { AgentTag } from "@look/ui/components/AgentTag";
import { McpTag } from "@look/ui/components/McpTag";
import { SkillTag } from "@look/ui/components/SkillTag";
import { useAtomValue, useSetAtom } from "jotai";
import { type ComponentPropsWithoutRef, isValidElement, type ReactNode } from "react";
import type { Components } from "streamdown";
import { coalesceChildren, looksLikeFilePath, resolveToAbsolutePath } from "../../lib/filePathDetection";
import { slugifyHeading } from "../../lib/markdownToc";
import { activeProjectAtom, requestViewFileAtom } from "../../store/atoms";
import { DocPathChip } from "./DocPathChip";

type ElementProps<T extends keyof React.JSX.IntrinsicElements> = ComponentPropsWithoutRef<T> & { node?: unknown };

function withoutNode<T extends { node?: unknown }>({ node: _node, ...props }: T): Omit<T, "node"> {
	return props;
}

/**
 * 递归提取标题的纯文本内容:React 元素取其子文本(img 取 alt),
 * 与 markdownToc.plainText 处理原始 markdown 的结果对齐,保证
 * 含粗体/链接/代码等行内格式的标题得到相同的 slug。
 * 注意与 filePathDetection.coalesceChildren 语义不同——那里有意忽略元素节点。
 */
function extractTextContent(children: ReactNode): string {
	if (children == null || typeof children === "boolean") return "";
	if (typeof children === "string") return children;
	if (typeof children === "number") return String(children);
	if (Array.isArray(children)) return children.map(extractTextContent).join("");
	if (isValidElement(children)) {
		const props = children.props as { children?: ReactNode; alt?: unknown };
		const text = extractTextContent(props.children);
		return text || (typeof props.alt === "string" ? props.alt : "");
	}
	return "";
}

function Heading({ level, className, children, ...props }: ElementProps<"h1"> & { level: 1 | 2 | 3 | 4 | 5 | 6 }) {
	const Tag = `h${level}` as const;
	// 与 markdownToc.slugifyHeading 一致,供文件预览的目录导航定位;
	// data-toc-slug 配合 TocHeading.occurrence 让重复/富文本标题也能精确定位
	const slug = slugifyHeading(extractTextContent(children));
	return (
		<Tag
			{...withoutNode(props)}
			id={slug || undefined}
			data-toc-slug={slug || undefined}
			className={cn("look-md-heading", `look-md-h${level}`, className)}
		>
			{children}
		</Tag>
	);
}

function LookTable({ className, ...props }: ElementProps<"table">) {
	return (
		<div className="look-md-table-wrap">
			<table {...withoutNode(props)} className={cn("look-md-table", className)} />
		</div>
	);
}

function externalLinkProps(href: string | undefined): Pick<ElementProps<"a">, "target" | "rel"> {
	if (!href || href.startsWith("#")) return {};
	return { target: "_blank", rel: "noreferrer noopener" };
}

function stringProp(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function SkillReference(props: Record<string, unknown>) {
	const name = stringProp(props["data-look-name"]);
	return name ? <SkillTag name={name} /> : null;
}

function AgentReference(props: Record<string, unknown>) {
	const name = stringProp(props["data-look-name"]);
	return name ? <AgentTag name={name} /> : null;
}

function McpReference(props: Record<string, unknown>) {
	const server = stringProp(props["data-look-server"]);
	const toolName = stringProp(props["data-look-tool"]);
	return server && toolName ? <McpTag server={server} toolName={toolName} /> : null;
}

function FileReference(props: Record<string, unknown>) {
	const requestViewFile = useSetAtom(requestViewFileAtom);
	const activeProject = useAtomValue(activeProjectAtom);
	const path = stringProp(props["data-look-path"]);
	if (!path) return null;
	// data-look-path 可能是绝对路径或相对路径,相对时按项目 cwd 解析
	const handleClick = () => {
		const absolutePath = resolveToAbsolutePath(path, window.look?.homedir ?? "", activeProject?.cwd ?? null);
		requestViewFile(absolutePath);
	};
	return <DocPathChip rawPath={path} onOpen={handleClick} atMention />;
}

function InlineCode({ className, children, ...props }: ElementProps<"code">) {
	const requestViewFile = useSetAtom(requestViewFileAtom);
	const text = coalesceChildren(children);
	if (looksLikeFilePath(text)) {
		// 点击时才解析绝对路径(~/ 需要 homedir),渲染保持无副作用
		const handleClick = () => {
			const absolutePath = resolveToAbsolutePath(text, window.look?.homedir ?? "");
			requestViewFile(absolutePath);
		};
		return <DocPathChip rawPath={text} onOpen={handleClick} />;
	}
	return (
		<code {...withoutNode(props)} className={cn("look-md-inline-code", className)} data-streamdown="inline-code">
			{children}
		</code>
	);
}

function Strong({ className, ...props }: ElementProps<"strong">) {
	return <strong {...withoutNode(props)} className={cn("look-md-strong", className)} />;
}

/** Minimal HAST element shape for node-tree inspection. */
interface HastNode {
	type?: string;
	tagName?: string;
	children?: Array<HastNode | { type: string; value?: string }>;
}

/**
 * Check whether the HAST subtree contains an <img> element.
 * Streamdown wraps every <img> in a block-level <div data-streamdown="image-wrapper">,
 * so a paragraph containing an image MUST render as a <div> to avoid HTML nesting errors.
 */
function containsImgDescendant(node: unknown): boolean {
	const n = node as HastNode | null | undefined;
	if (!n || typeof n !== "object") return false;
	if (n.tagName === "img") return true;
	if (Array.isArray(n.children)) {
		for (const child of n.children) {
			if (containsImgDescendant(child)) return true;
		}
	}
	return false;
}

function Paragraph({ className, node, ...props }: ElementProps<"p">) {
	const Tag = containsImgDescendant(node) ? "div" : "p";
	return <Tag {...props} className={cn("look-md-paragraph", className)} />;
}

function Blockquote({ className, ...props }: ElementProps<"blockquote">) {
	return <blockquote {...withoutNode(props)} className={cn("look-md-blockquote", className)} />;
}

function List({ ordered, className, ...props }: ElementProps<"ul"> & { ordered?: boolean }) {
	if (ordered) {
		return <ol {...withoutNode(props)} className={cn("look-md-list look-md-list--ordered", className)} />;
	}
	return <ul {...withoutNode(props)} className={cn("look-md-list look-md-list--unordered", className)} />;
}

function ListItem({ className, ...props }: ElementProps<"li">) {
	return <li {...withoutNode(props)} className={cn("look-md-list-item", className)} />;
}

function TableHead({ className, ...props }: ElementProps<"thead">) {
	return <thead {...withoutNode(props)} className={cn("look-md-thead", className)} />;
}

function TableBody({ className, ...props }: ElementProps<"tbody">) {
	return <tbody {...withoutNode(props)} className={cn("look-md-tbody", className)} />;
}

function TableRow({ className, ...props }: ElementProps<"tr">) {
	return <tr {...withoutNode(props)} className={cn("look-md-tr", className)} />;
}

function TableCell({ header, className, ...props }: ElementProps<"td"> & { header?: boolean }) {
	if (header) return <th {...withoutNode(props)} className={cn("look-md-th", className)} />;
	return <td {...withoutNode(props)} className={cn("look-md-td", className)} />;
}

function Link({ className, href, children, ...props }: ElementProps<"a"> & { children?: ReactNode }) {
	return (
		<a {...withoutNode(props)} href={href} {...externalLinkProps(href)} className={cn("look-md-link", className)}>
			{children}
		</a>
	);
}

export const lookMarkdownComponents = {
	h1: (props) => <Heading {...(props as ElementProps<"h1">)} level={1} />,
	h2: (props) => <Heading {...(props as ElementProps<"h1">)} level={2} />,
	h3: (props) => <Heading {...(props as ElementProps<"h1">)} level={3} />,
	h4: (props) => <Heading {...(props as ElementProps<"h1">)} level={4} />,
	h5: (props) => <Heading {...(props as ElementProps<"h1">)} level={5} />,
	h6: (props) => <Heading {...(props as ElementProps<"h1">)} level={6} />,
	p: Paragraph,
	ul: (props) => <List {...(props as ElementProps<"ul">)} />,
	ol: (props) => <List {...(props as ElementProps<"ul">)} ordered />,
	li: ListItem,
	a: Link,
	strong: Strong,
	inlineCode: InlineCode,
	blockquote: Blockquote,
	table: LookTable,
	thead: TableHead,
	tbody: TableBody,
	tr: TableRow,
	th: (props) => <TableCell {...(props as ElementProps<"td">)} header />,
	td: TableCell,
	hr: ({ className, ...props }) => <hr {...withoutNode(props)} className={cn("look-md-rule", className)} />,
	"skill-tag": SkillReference,
	"agent-tag": AgentReference,
	"mcp-tag": McpReference,
	"file-tag": FileReference,
} satisfies Components;
