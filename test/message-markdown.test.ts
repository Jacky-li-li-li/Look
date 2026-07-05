import { describe, expect, it } from "vitest";
import {
	closeAtxHeadings,
	escapeGlobAsterisks,
	prepareMessageContent,
	stripSystemHints,
} from "../src/renderer/lib/messageMarkdown";

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

describe("escapeGlobAsterisks", () => {
	it("escapes file globs outside code fences", () => {
		const input = "Load all *.md files";
		expect(escapeGlobAsterisks(input)).toBe("Load all \\*.md files");
	});

	it("does not escape globs inside fenced code blocks", () => {
		const input = "```text\n*.md\n```";
		expect(escapeGlobAsterisks(input)).toBe(input);
	});

	it("preserves normal emphasis", () => {
		expect(escapeGlobAsterisks("this is *italic*")).toBe("this is *italic*");
	});
});

describe("prepareMessageContent", () => {
	it("converts /skill:name to a skill-tag", () => {
		expect(prepareMessageContent("Use /skill:search to find it")).toBe(
			'Use <skill-tag name="search"></skill-tag> to find it',
		);
	});

	it("converts /agent:name to an agent-tag", () => {
		expect(prepareMessageContent("Ask /agent:planner for help")).toBe(
			'Ask <agent-tag name="planner"></agent-tag> for help',
		);
	});

		it("converts @file references to file-tag", () => {
			expect(prepareMessageContent("Open @src/app.ts")).toBe(
				'Open <file-tag path="src/app.ts"></file-tag>',
			);
		});

	it("converts legacy <skill> blocks to skill-tags", () => {
		const input = 'prefix <skill name="foo" location="/x">body</skill> suffix';
		expect(prepareMessageContent(input)).toBe(
			'prefix <skill-tag name="foo"></skill-tag> suffix',
		);
	});

	it("converts legacy <skill-invoke> blocks to skill-tags", () => {
		const input = '<skill-invoke name="bar" location="/y">args</skill-invoke>';
		expect(prepareMessageContent(input)).toBe('<skill-tag name="bar"></skill-tag>');
	});

	it("escapes globs while preserving chips", () => {
		expect(prepareMessageContent("Check *.md and /skill:read")).toBe(
			'Check \\*.md and <skill-tag name="read"></skill-tag>',
		);
	});

	it("does not treat markdown headings as agents", () => {
		expect(prepareMessageContent("# Title\n\nHello")).toBe("# Title\n\nHello");
	});
});

describe("closeAtxHeadings", () => {
	it("adds a closing sequence to an H1 without one", () => {
		expect(closeAtxHeadings("# Hello\n\nThis is **bold**.")).toBe(
			"# Hello #\n\nThis is **bold**.",
		);
	});

	it("leaves fenced code alone", () => {
		const input = "```\n# Hello\n```";
		expect(closeAtxHeadings(input)).toBe(input);
	});
});
