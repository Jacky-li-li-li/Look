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

	it("renders basic markdown", async () => {
		const content = `# Hello

This is **bold**.`;
		const { container } = render(<LookMarkdown content={content} />);
		await waitFor(() => expect(container.querySelector("h1")).not.toBeNull());
		expect(container.querySelector("h1")?.textContent).toBe("Hello");
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

	it("renders streaming content without error", async () => {
		const { container, rerender } = render(<LookMarkdown content="Hello" isStreaming />);
		await waitFor(() => expect(container.textContent).toContain("Hello"), { timeout: 3000 });
		rerender(<LookMarkdown content="Hello world" isStreaming />);
		await waitFor(() => expect(container.textContent).toContain("Hello world"), { timeout: 3000 });
	});

	it("uses native smooth streaming instead of disabling it", () => {
		expect(SRC).toMatch(/smoothStreaming=\{isStreaming\}/);
		expect(SRC).toMatch(/STREAMING_MARKDOWN_SMOOTH_OPTIONS/);
		expect(SRC).not.toMatch(/smoothStreaming=\{false\}/);
	});

	it("uses the document tone for Markstream's dark rendering mode", async () => {
		writeLookThemeToDom("dark");
		const { container } = render(<LookMarkdown content="```ts\nconst visible = true;\n```" />);
		await waitFor(() => expect(container.querySelector(".markstream-react.dark")).not.toBeNull());

		writeLookThemeToDom("light");
		await waitFor(() => expect(container.querySelector(".markstream-react.dark")).toBeNull());
	});

	it("does not read Markdown appearance from next-themes", () => {
		expect(SRC).toMatch(/const \{ tone \} = useLookTheme\(\)/);
		expect(SRC).toMatch(/isDark=\{tone === "dark"\}/);
		expect(SRC).not.toMatch(/next-themes/);
	});
});
