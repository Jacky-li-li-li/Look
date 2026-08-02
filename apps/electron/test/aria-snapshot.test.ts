import { describe, expect, it } from "vitest";
import { buildAriaSnapshotFunction, buildAriaSnapshotScript } from "../src/main/browser/aria-snapshot";

describe("aria-snapshot", () => {
	it("buildAriaSnapshotScript returns an IIFE string", () => {
		const script = buildAriaSnapshotScript();
		expect(script.startsWith("(() => {")).toBe(true);
		expect(script.endsWith("})()")).toBe(true);
		// 脚本包含核心快照逻辑
		expect(script).toContain("interactiveRoles");
		expect(script).toContain("walk(document.body, 0)");
	});

	it("buildAriaSnapshotFunction returns a callable function declaration", () => {
		const fn = buildAriaSnapshotFunction();
		expect(fn.startsWith("function __lookAriaSnapshot() {")).toBe(true);
		expect(fn.endsWith("}")).toBe(true);
		// 共享函数体包含核心快照逻辑
		expect(fn).toContain("return { timestamp: Date.now(), title, url, elements };");
	});

	it("non-interactive containers are filtered (walk returns ids only for listed elements)", () => {
		const body = buildAriaSnapshotFunction();
		// 验证透传逻辑：非交互容器直接递归子元素，不 push 自身
		expect(body).toContain("if (!isInteractive && el.children.length > 0)");
		expect(body).toContain("for (const child of el.children) out.push(...walk(child, depth))");
		expect(body).not.toContain("const seen = new Set()");
	});

	it("exposes interactive element attributes", () => {
		const body = buildAriaSnapshotFunction();
		expect(body).toContain('el.getAttribute("aria-checked")');
		expect(body).toContain('el.getAttribute("aria-expanded")');
		expect(body).toContain('el.getAttribute("aria-selected")');
		expect(body).toContain("HTMLInputElement");
		expect(body).toContain("placeholder");
	});

	it("role=none/presentation pass through children without listing", () => {
		const body = buildAriaSnapshotFunction();
		expect(body).toContain('role === "none" || role === "presentation"');
	});
});
