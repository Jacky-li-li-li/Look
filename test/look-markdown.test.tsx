// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LookMarkdown from "../src/renderer/components/LookMarkdown";

beforeEach(() => {
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		return setTimeout(() => callback(performance.now()), 16) as unknown as number;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>));
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("LookMarkdown", () => {
	const SRC = readFileSync(resolve(__dirname, "../src/renderer/components/LookMarkdown.tsx"), "utf8");

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
});
