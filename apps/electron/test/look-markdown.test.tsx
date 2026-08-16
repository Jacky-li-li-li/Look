// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LookMarkdown from "../src/renderer/components/markdown/LookMarkdown";
import { writeLookThemeToDom } from "../src/renderer/lib/look-theme";

beforeEach(() => {
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		return setTimeout(() => callback(performance.now()), 16) as unknown as number;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>));
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	writeLookThemeToDom("dark");
});

describe("LookMarkdown", () => {
	const SRC = readFileSync(resolve(__dirname, "../src/renderer/components/markdown/LookMarkdown.tsx"), "utf8");
	const APP_CSS = readFileSync(resolve(__dirname, "../src/renderer/App.css"), "utf8");

	it("matches TOC slugs for headings with inline formatting and duplicates", async () => {
		const content = [
			"## 参见 [文档](https://example.com)",
			"",
			"## 配置 `config.json` 说明",
			"",
			"## 重复",
			"",
			"## 重复",
		].join("\n");
		const { container } = render(<LookMarkdown content={content} docs />);
		await waitFor(() => expect(container.querySelectorAll("h2").length).toBe(4));
		const slugs = [...container.querySelectorAll("h2")].map((h) => h.getAttribute("data-toc-slug"));
		expect(slugs).toEqual(["参见-文档", "配置-configjson-说明", "重复", "重复"]);
	});

	it("renders basic markdown", async () => {
		const content = `# Hello

## Details

This is **bold**.`;
		const { container } = render(<LookMarkdown content={content} />);
		await waitFor(() => expect(container.querySelector("strong")?.textContent).toBe("bold"));
		expect(container.querySelector("h1")?.textContent).toBe("Hello");
		expect(container.querySelector("h2")?.textContent).toBe("Details");
		expect(container.querySelector("h1")?.classList.contains("look-md-h1")).toBe(true);
		expect(container.querySelector("h2")?.classList.contains("look-md-h2")).toBe(true);
		expect(container.querySelector("strong")?.textContent).toBe("bold");
	});

	it("does not italicise file globs", async () => {
		const { container } = render(<LookMarkdown content="Load all *.md files" />);
		await waitFor(() => expect(container.querySelector("em")).toBeNull());
		expect(container.textContent).toContain("*.md");
	});

	it("renders /skill:name as a skill chip", async () => {
		const { container } = render(<LookMarkdown content="Use /skill:search here" />);
		await waitFor(() => expect(container.textContent).toContain("/skill:search"));
		expect(container.querySelector("[data-icon='inline-start']")).not.toBeNull();
	});

	it("renders /agent:name as an agent chip", async () => {
		const { container } = render(<LookMarkdown content="Ask /agent:planner" />);
		await waitFor(() => expect(container.textContent).toContain("/agent:planner"));
	});

	it("renders MCP and file references as chips", async () => {
		const { container } = render(<LookMarkdown content="Call #github__search and open @src/app.ts" />);
		await waitFor(() => expect(container.textContent).toContain("#github__search"));
		expect(container.textContent).toContain("@src/app.ts");
	});

	it("renders historical custom tags with their original values", async () => {
		const content = '<skill-tag name="search"></skill-tag> <agent-tag name="planner"></agent-tag>';
		const { container } = render(<LookMarkdown content={content} />);
		await waitFor(() => expect(container.textContent).toContain("/skill:search"));
		expect(container.textContent).toContain("/agent:planner");
		expect(container.textContent).not.toContain("user-content-");
	});

	it("collapses historical skill payloads without exposing their body", async () => {
		const content = 'before <skill name="search" location="/tmp/SKILL.md">private body</skill> after';
		const { container } = render(<LookMarkdown content={content} />);
		await waitFor(() => expect(container.textContent).toContain("/skill:search"));
		expect(container.textContent).toContain("before");
		expect(container.textContent).toContain("after");
		expect(container.textContent).not.toContain("private body");
	});

	it("renders GFM lists and tables with Look-owned components", async () => {
		const content = "- one\n- two\n\n| Name | State |\n| --- | --- |\n| Markdown | Ready |";
		const { container } = render(<LookMarkdown content={content} />);
		await waitFor(() => expect(container.querySelector("table")).not.toBeNull());
		expect(container.querySelectorAll(".look-md-list-item")).toHaveLength(2);
		expect(container.querySelector(".look-md-table-wrap")).not.toBeNull();
		expect(container.querySelector(".look-md-th")?.textContent).toBe("Name");
	});

	it("does not turn references inside code into chips", async () => {
		const content = "```text\n/skill:search #github__search @src/app.ts\n```";
		const { container } = render(<LookMarkdown content={content} />);
		await waitFor(() => expect(container.textContent).toContain("/skill:search"));
		expect(container.querySelector("[data-icon='inline-start']")).toBeNull();
	});

	it("keeps content after a closed code fence outside the code block", async () => {
		const content = "```ts\nconst ready = true;\n```\n\n## After code\n\nStill readable.";
		const { container } = render(<LookMarkdown content={content} />);
		await waitFor(() => expect(container.querySelector("h2")?.textContent).toBe("After code"));
		expect(container.querySelector('[data-streamdown="code-block"]')?.textContent).not.toContain("After code");
		expect(container.textContent).toContain("Still readable.");
	});

	it("renders unlabeled box-drawing architecture as a dedicated ASCII diagram", async () => {
		const content = "```\n┌──────────┐\n│ Renderer │\n└────┬─────┘\n     ▼\n```";
		const { container } = render(<LookMarkdown content={content} />);
		await waitFor(() => expect(container.querySelector("[data-look-ascii-diagram]")).not.toBeNull());
		expect(container.querySelector("[data-look-ascii-diagram] pre")?.textContent).toContain("│ Renderer │");
		expect(container.querySelector('[data-streamdown="code-block"]')).toBeNull();
		expect(container.querySelector('button[aria-label="Copy diagram"]')).not.toBeNull();
	});

	it("renders streaming content without error", async () => {
		const { container, rerender } = render(<LookMarkdown content="Hello" isStreaming />);
		await waitFor(() => expect(container.textContent).toContain("Hello"), { timeout: 3000 });
		const firstAnimatedWord = container.querySelector<HTMLElement>("[data-sd-animate]");
		expect(firstAnimatedWord?.style.getPropertyValue("--sd-animation")).toBe("sd-look-text-reveal");
		expect(firstAnimatedWord?.style.getPropertyValue("--sd-easing")).toBe("cubic-bezier(0, 0, 0.2, 1)");
		expect(firstAnimatedWord?.style.getPropertyValue("--sd-delay")).toBe("");
		rerender(<LookMarkdown content="Hello world" isStreaming />);
		await waitFor(() => expect(container.textContent).toContain("Hello world"), { timeout: 3000 });
		await waitFor(() => {
			const words = [...container.querySelectorAll<HTMLElement>("[data-sd-animate]")];
			expect(words.find((word) => word.textContent === "Hello")?.style.getPropertyValue("--sd-duration")).toBe(
				"0ms",
			);
			expect(words.find((word) => word.textContent === "world")?.style.getPropertyValue("--sd-duration")).toBe(
				"300ms",
			);
			expect(words.every((word) => word.style.getPropertyValue("--sd-delay") === "")).toBe(true);
		});
	});

	it("does not add streaming reveal wrappers to settled content", async () => {
		const { container } = render(<LookMarkdown content="Already settled" />);
		await waitFor(() => expect(container.textContent).toContain("Already settled"));
		expect(container.querySelector("[data-sd-animate]")).toBeNull();
	});

	it("keeps animated words in the normal inline formatting context", () => {
		const rule = APP_CSS.match(/\.look-markdown--streaming \[data-sd-animate\] \{([^}]*)\}/)?.[1];
		expect(rule).toContain("position: relative");
		expect(rule).toContain("top: 0");
		expect(rule).not.toContain("display: inline-block");
		expect(APP_CSS).toMatch(/@keyframes sd-look-text-reveal[\s\S]*?transform: translateY\(-0\.45em\)/);
	});

	it("uses Streamdown incomplete-Markdown handling only while streaming", () => {
		expect(SRC).toMatch(/parseIncompleteMarkdown=\{isStreaming\}/);
		expect(SRC).toMatch(/isAnimating=\{isStreaming\}/);
		expect(SRC).toMatch(/animated=\{STREAMING_TEXT_ANIMATION\}/);
		expect(SRC).toMatch(/animation:\s*"look-text-reveal"/);
		expect(SRC).toMatch(/easing:\s*"cubic-bezier\(0, 0, 0\.2, 1\)"/);
		expect(SRC).toMatch(/stagger:\s*0/);
		expect(APP_CSS).toMatch(/prefers-reduced-motion:[\s\S]*?animation-delay:\s*0\.01ms/);
		expect(SRC).toMatch(/mode=\{docs \? "static" : "streaming"\}/);
	});

	it("configures matching light and dark Shiki themes", () => {
		expect(SRC).toMatch(/themes: \["github-light", "github-dark"\]/);
		expect(SRC).toMatch(/shikiTheme=\{\["github-light", "github-dark"\]\}/);
	});

	it("configures the official Mermaid plugin with theme and strict security", () => {
		expect(SRC).toMatch(/@streamdown\/mermaid/);
		expect(SRC).toMatch(/import\("@streamdown\/mermaid"\)/);
		expect(SRC).toMatch(/mermaid:\s*diagramPlugin/);
		expect(SRC).toMatch(/securityLevel:\s*"strict"/);
		expect(SRC).toMatch(/theme:\s*scheme === "dark" \? "dark" : "neutral"/);
	});

	it("does not depend on Markstream workarounds", () => {
		expect(SRC).not.toMatch(/markstream-react/);
		expect(SRC).not.toMatch(/closeAtxHeadings/);
	});
});
