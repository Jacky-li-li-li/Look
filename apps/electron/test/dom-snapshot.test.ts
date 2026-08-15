import { describe, expect, it } from "vitest";
import { buildDomSnapshotFunction, buildDomSnapshotScript } from "../src/main/browser/dom-snapshot";

describe("dom-snapshot", () => {
	it("buildDomSnapshotScript returns an IIFE string", () => {
		const script = buildDomSnapshotScript();
		expect(script.startsWith("(() => {")).toBe(true);
		expect(script.endsWith("})()")).toBe(true);
		// 脚本包含核心快照逻辑
		expect(script).toContain("interactiveRoles");
		expect(script).toContain("walk(document.body, 0)");
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
});
