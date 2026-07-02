// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import LookMarkdown from "../src/renderer/components/LookMarkdown";

afterEach(() => {
	cleanup();
});

describe("LookMarkdown", () => {
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

	it("renders #agentName as an agent chip", async () => {
		const { container } = render(<LookMarkdown content="Ask #planner" />);
		await waitFor(() => expect(container.textContent).toContain("#planner"));
	});

	it("renders streaming content without error", async () => {
		const { container, rerender } = render(<LookMarkdown content="Hello" isStreaming />);
		await waitFor(() => expect(container.textContent).toContain("Hello"));
		rerender(<LookMarkdown content="Hello world" isStreaming />);
		await waitFor(() => expect(container.textContent).toContain("Hello world"));
	});
});
