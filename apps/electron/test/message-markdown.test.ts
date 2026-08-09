import { describe, expect, it } from "vitest";
import { prepareMessageContent, stripSystemHints } from "../src/renderer/lib/messageMarkdown";
import { isAsciiDiagram, remarkLookReferences, tokenizeLookReferences } from "../src/renderer/lib/remarkLookReferences";

describe("stripSystemHints", () => {
	it("removes a single subagent hint", () => {
		expect(stripSystemHints("[Use subagent: planner]\n\nHello")).toBe("Hello");
	});

	it("removes a plural subagent hint", () => {
		expect(stripSystemHints("[Use subagents: planner, scout]\nHello")).toBe("Hello");
	});

	it("leaves normal content alone", () => {
		expect(stripSystemHints("Hello")).toBe("Hello");
	});
});

describe("prepareMessageContent", () => {
	it("leaves user references for the parser-aware remark plugin", () => {
		const input = "Use /skill:search, ask /agent:planner, call #github__search, then open @src/app.ts.";
		expect(prepareMessageContent(input)).toBe(input);
	});

	it("leaves legacy skill payloads for parser-aware normalization", () => {
		const input = 'prefix <skill name="foo" location="/x">body</skill> suffix';
		expect(prepareMessageContent(input)).toBe(input);
	});

	it("leaves compact legacy skill invocations for parser-aware normalization", () => {
		const input = '<skill-invoke name="bar" location="/y">args</skill-invoke>';
		expect(prepareMessageContent(input)).toBe(input);
	});

	it("does not rewrite ordinary Markdown syntax", () => {
		const input = "# Title\n\nLoad `*.md` files.";
		expect(prepareMessageContent(input)).toBe(input);
	});
});

describe("remarkLookReferences", () => {
	it("recognizes multiline box-drawing diagrams but not ordinary code", () => {
		const diagram = "┌──────────┐\n│ Renderer │\n└────┬─────┘\n     ▼";
		expect(isAsciiDiagram(diagram)).toBe(true);
		expect(isAsciiDiagram(diagram, "text")).toBe(true);
		expect(isAsciiDiagram(diagram, "typescript")).toBe(false);
		expect(isAsciiDiagram("const line = '────────';", "typescript")).toBe(false);
	});

	it("tokenizes references and keeps trailing punctuation outside file tags", () => {
		const nodes = tokenizeLookReferences("Use /skill:search and @src/app.ts.");
		expect(nodes).toEqual([
			{ type: "text", value: "Use " },
			{ type: "html", value: '<skill-tag data-look-name="search"></skill-tag>' },
			{ type: "text", value: " and " },
			{ type: "html", value: '<file-tag data-look-path="src/app.ts"></file-tag>' },
			{ type: "text", value: "." },
		]);
	});

	it("tokenizes file references adjacent to CJK text", () => {
		const nodes = tokenizeLookReferences("当前@README.md 可以优化下么");
		expect(nodes).toEqual([
			{ type: "text", value: "当前" },
			{ type: "html", value: '<file-tag data-look-path="README.md"></file-tag>' },
			{ type: "text", value: " 可以优化下么" },
		]);
	});

	it("keeps emails with latin prefix intact even after CJK text", () => {
		const nodes = tokenizeLookReferences("联系 test@example.com 处理");
		expect(nodes).toEqual([{ type: "text", value: "联系 test@example.com 处理" }]);
	});

	it("only transforms text nodes and preserves fenced and inline code", () => {
		const tree = {
			type: "root",
			children: [
				{ type: "code", value: "/skill:search #github__search @src/app.ts" },
				{
					type: "paragraph",
					children: [
						{ type: "inlineCode", value: "@src/app.ts" },
						{ type: "text", value: " then @src/app.ts" },
					],
				},
			],
		};
		remarkLookReferences()(tree);

		expect(tree.children[0]).toEqual({
			type: "code",
			value: "/skill:search #github__search @src/app.ts",
		});
		expect(tree.children[1].children?.[0]).toEqual({ type: "inlineCode", value: "@src/app.ts" });
		expect(tree.children[1].children?.[2]).toEqual({
			type: "html",
			value: '<file-tag data-look-path="src/app.ts"></file-tag>',
		});
	});

	it("marks unlabeled box-drawing code nodes for the ASCII renderer", () => {
		const tree = {
			type: "root",
			children: [{ type: "code", value: "┌──────────┐\n│ Renderer │\n└────┬─────┘\n     ▼" }],
		};
		remarkLookReferences()(tree);
		expect(tree.children[0]).toMatchObject({ type: "code", lang: "ascii" });
	});

	it("collapses split legacy skill blocks without exposing their payload", () => {
		const tree = {
			type: "root",
			children: [
				{
					type: "paragraph",
					children: [
						{ type: "text", value: "before " },
						{ type: "html", value: '<skill name="search" location="/tmp/SKILL.md">' },
						{ type: "text", value: "private skill body" },
						{ type: "html", value: "</skill>" },
						{ type: "text", value: " after" },
					],
				},
			],
		};
		remarkLookReferences()(tree);

		expect(tree.children[0].children).toEqual([
			{ type: "text", value: "before " },
			{ type: "html", value: '<skill-tag data-look-name="search"></skill-tag>' },
			{ type: "text", value: " after" },
		]);
	});

	it("normalizes historical custom-tag attributes", () => {
		const tree = {
			type: "root",
			children: [
				{ type: "html", value: '<skill-tag name="search"></skill-tag>' },
				{ type: "html", value: '<agent-tag name="planner"></agent-tag>' },
				{ type: "html", value: '<mcp-tag server="github" tool="search"></mcp-tag>' },
				{ type: "html", value: '<file-tag path="src/app.ts"></file-tag>' },
			],
		};
		remarkLookReferences()(tree);

		expect(tree.children).toEqual([
			{ type: "html", value: '<skill-tag data-look-name="search"></skill-tag>' },
			{ type: "html", value: '<agent-tag data-look-name="planner"></agent-tag>' },
			{
				type: "html",
				value: '<mcp-tag data-look-server="github" data-look-tool="search"></mcp-tag>',
			},
			{ type: "html", value: '<file-tag data-look-path="src/app.ts"></file-tag>' },
		]);
	});
});
