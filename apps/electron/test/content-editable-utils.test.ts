// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { renderToDOM } from "../src/renderer/components/chat/contentEditableUtils";

describe("contentEditableUtils", () => {
	it("renders supported input references as non-editable chips", () => {
		const container = document.createElement("div");
		renderToDOM(container, "Use /skill:search /agent:planner #github__search @src/app.ts");

		expect(container.querySelector('[data-skill-chip][data-name="search"]')).not.toBeNull();
		expect(container.querySelector('[data-agent-chip][data-name="planner"]')).not.toBeNull();
		expect(container.querySelector('[data-mcp-chip][data-name="github__search"]')).not.toBeNull();
		expect(container.querySelector('[data-file-chip][data-path="src/app.ts"]')).not.toBeNull();
		expect(container.querySelectorAll('[contenteditable="false"]')).toHaveLength(4);
	});

	it("keeps unrelated text as plain text", () => {
		const container = document.createElement("div");
		renderToDOM(container, "Email user@example.com and load plain text");

		expect(container.querySelector("[data-file-chip]")).toBeNull();
		expect(container.textContent).toBe("Email user@example.com and load plain text");
	});

	it("chips file references adjacent to CJK text", () => {
		const container = document.createElement("div");
		renderToDOM(container, "当前@README.md 可以优化下么");

		expect(container.querySelector('[data-file-chip][data-path="README.md"]')).not.toBeNull();
		expect(container.querySelector("[data-file-chip]")?.textContent).toBe("@README.md");
		// 前缀文本保留在普通文本节点中
		expect(container.firstChild?.textContent).toBe("当前");
	});

	it("still protects emails with CJK-adjacent latin prefix from file chips", () => {
		const container = document.createElement("div");
		renderToDOM(container, "联系 test@example.com 处理");

		expect(container.querySelector("[data-file-chip]")).toBeNull();
	});
});
