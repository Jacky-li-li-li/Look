import { AgentTag } from "@shared/components/AgentTag";
import { FileTag } from "@shared/components/FileTag";
import { McpTag } from "@shared/components/McpTag";
import { SkillTag } from "@shared/components/SkillTag";
import { cn } from "@shared/lib/utils";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import type { Components } from "streamdown";

type ElementProps<T extends keyof React.JSX.IntrinsicElements> = ComponentPropsWithoutRef<T> & { node?: unknown };

function withoutNode<T extends { node?: unknown }>({ node: _node, ...props }: T): Omit<T, "node"> {
	return props;
}

function Heading({ level, className, ...props }: ElementProps<"h1"> & { level: 1 | 2 | 3 | 4 | 5 | 6 }) {
	const Tag = `h${level}` as const;
	return <Tag {...withoutNode(props)} className={cn("look-md-heading", `look-md-h${level}`, className)} />;
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
	const path = stringProp(props["data-look-path"]);
	return path ? <FileTag path={path} /> : null;
}

function InlineCode({ className, ...props }: ElementProps<"code">) {
	return (
		<code {...withoutNode(props)} className={cn("look-md-inline-code", className)} data-streamdown="inline-code" />
	);
}

function Strong({ className, ...props }: ElementProps<"strong">) {
	return <strong {...withoutNode(props)} className={cn("look-md-strong", className)} />;
}

function Paragraph({ className, ...props }: ElementProps<"p">) {
	return <p {...withoutNode(props)} className={cn("look-md-paragraph", className)} />;
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
