import { describe, expect, it } from "vitest";
import { buildDomSnapshotFunction, buildDomSnapshotScript } from "../src/main/browser/dom-snapshot";

// dom-snapshot 生成的是页面内执行的脚本字符串；这里对脚本源码做结构断言
// （快照逻辑运行在页面上下文，单测无法直接执行 DOM）。

describe("dom-snapshot", () => {
	it("buildDomSnapshotScript returns an IIFE string", () => {
		const script = buildDomSnapshotScript();
		expect(script.startsWith("(() => {")).toBe(true);
		expect(script.endsWith("})()")).toBe(true);
		// 脚本包含核心快照逻辑
		expect(script).toContain("interactiveRoles");
		expect(script).toContain("walk(document.body, 0, false)");
		expect(script).toContain("window.__lookAriaElements = elementsByIndex");
	});

	it("buildDomSnapshotFunction returns a callable function declaration", () => {
		const fn = buildDomSnapshotFunction();
		expect(fn.startsWith("function __lookDomSnapshot() {")).toBe(true);
		expect(fn.endsWith("}")).toBe(true);
		// 返回结构化快照对象
		expect(fn).toContain("return {");
		expect(fn).toContain("tree");
		expect(fn).toContain("pageStats");
		expect(fn).toContain("pageInfo");
	});

	it("assigns global 1-based indexes to interactive elements", () => {
		const body = buildDomSnapshotFunction();
		expect(body).toContain("let indexCounter = 0");
		expect(body).toContain("const index = ++indexCounter");
		expect(body).toContain("data-look-ref");
	});

	it("non-interactive containers are filtered (walk recurses without listing)", () => {
		const body = buildDomSnapshotFunction();
		expect(body).toContain('role === "none" || role === "presentation"');
		expect(body).toContain("for (const child of node.children)");
	});

	it("includes input constraint attributes for the model", () => {
		const body = buildDomSnapshotFunction();
		for (const attr of ["maxlength", "minlength", "pattern", "accept", "autocomplete", "placeholder", "value"]) {
			expect(body).toContain(attr);
		}
	});

	it("annotates shadow DOM, iframes, and scroll containers", () => {
		const body = buildDomSnapshotFunction();
		expect(body).toContain("|SHADOW(open)|");
		expect(body).toContain("|IFRAME|");
		expect(body).toContain("|scroll element[");
		expect(body).toContain("isScrollable");
	});

	it("reports page stats and scroll hints", () => {
		const body = buildDomSnapshotFunction();
		expect(body).toContain("pagesAbove");
		expect(body).toContain("pagesBelow");
		expect(body).toContain("interactive");
		expect(body).toContain("iframes");
		expect(body).toContain("shadowOpen");
	});

	it("excludes password input values from the snapshot attrs", () => {
		const script = buildDomSnapshotScript();
		// value 读取必须排除 type === "password" 的输入框
		expect(script).toContain('el.type === "password"');
	});

	it("does not number elements inside shadow roots (they are not interactable)", () => {
		const script = buildDomSnapshotScript();
		// shadow root 递归走 insideShadow 分支：只展示、不编号、不打 data-look-ref
		expect(script).toContain("walk(el.shadowRoot, depth + 1, true)");
		expect(script).toContain("(in shadow DOM, not interactable)");
		// 编号（setAttribute data-look-ref）只出现在非 shadow 分支
		const numberBranch = script.indexOf("el.setAttribute(");
		const shadowBranch = script.indexOf("(in shadow DOM, not interactable)");
		expect(shadowBranch).toBeGreaterThan(-1);
		expect(numberBranch).toBeGreaterThan(shadowBranch);
	});

	it("marks shadow sections as not interactable in the tree output", () => {
		const script = buildDomSnapshotScript();
		expect(script).toContain("elements inside are not interactable");
	});
});
