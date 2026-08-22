// ============================================================
// browser-router 纯函数边界测试
//
// parseAction / parseLayout 是 browser-router 里仅有的、含自身逻辑
// （非纯委托）的函数：把不可信的 renderer 载荷解析为类型化对象。
// 路由的其余部分是薄委托到 BrowserService（已在 browser-service.test.ts
// 充分覆盖）。
//
// 这里钉死两个解析器的边界：合法 kind/字段、未知 kind 抛错、缺字段抛错、
// 可选字段、visible 仅接受 true、bounds 缺失/非对象抛错。
// ============================================================

import { describe, expect, it } from "vitest";
import { parseAction, parseLayout } from "../src/main/ipc/routers/browser-router.js";

describe("parseAction", () => {
	it("type 提取 text", () => {
		expect(parseAction({ text: "hello" }, "type")).toEqual({ kind: "type", text: "hello" });
	});

	it("press 提取 key", () => {
		expect(parseAction({ key: "Enter" }, "press")).toEqual({ kind: "press", key: "Enter" });
	});

	it("navigate 提取 url", () => {
		expect(parseAction({ url: "https://example.com" }, "navigate")).toEqual({
			kind: "navigate",
			url: "https://example.com",
		});
	});

	it("selectTab / closeTab 提取 name", () => {
		expect(parseAction({ name: "tab-1" }, "selectTab")).toEqual({ kind: "selectTab", name: "tab-1" });
		expect(parseAction({ name: "tab-2" }, "closeTab")).toEqual({ kind: "closeTab", name: "tab-2" });
	});

	it("newTab 的 url 可选（省略时为 undefined）", () => {
		expect(parseAction({}, "newTab")).toEqual({ kind: "newTab", url: undefined });
		expect(parseAction({ url: "https://x.io" }, "newTab")).toEqual({ kind: "newTab", url: "https://x.io" });
	});

	it("back / forward / reload 不取字段", () => {
		expect(parseAction({}, "back")).toEqual({ kind: "back" });
		expect(parseAction({}, "forward")).toEqual({ kind: "forward" });
		expect(parseAction({}, "reload")).toEqual({ kind: "reload" });
	});

	it("未知 kind 抛错并带上 kind 名", () => {
		expect(() => parseAction({}, "zoom")).toThrow(/Unsupported browser panel action/);
		expect(() => parseAction({}, "zoom")).toThrow(/zoom/);
	});

	it("type 缺 text 抛错", () => {
		expect(() => parseAction({}, "type")).toThrow();
	});

	it("press 缺 key 抛错", () => {
		expect(() => parseAction({}, "press")).toThrow();
	});

	it("navigate 缺 url 抛错", () => {
		expect(() => parseAction({}, "navigate")).toThrow();
	});

	it("selectTab 缺 name 抛错", () => {
		expect(() => parseAction({}, "selectTab")).toThrow();
	});
});

describe("parseLayout", () => {
	function validLayout(): Record<string, unknown> {
		return {
			layout: {
				handle: "h1",
				tab: "t1",
				revision: 3,
				visible: true,
				bounds: { x: 0, y: 0, width: 400, height: 300 },
			},
		};
	}

	it("合法载荷解析为 BrowserViewLayout", () => {
		expect(parseLayout(validLayout())).toEqual({
			handle: "h1",
			tab: "t1",
			revision: 3,
			visible: true,
			bounds: { x: 0, y: 0, width: 400, height: 300 },
		});
	});

	it("visible 非 true 时为 false（仅接受字面 true）", () => {
		const data = validLayout();
		(data.layout as Record<string, unknown>).visible = "true";
		expect(parseLayout(data).visible).toBe(false);
	});

	it("缺少 layout 抛错", () => {
		expect(() => parseLayout({})).toThrow(/缺少 layout/);
	});

	it("layout 非 object 抛错", () => {
		expect(() => parseLayout({ layout: "x" })).toThrow(/缺少 layout/);
		expect(() => parseLayout({ layout: null })).toThrow(/缺少 layout/);
	});

	it("缺少 bounds 抛错", () => {
		const data = validLayout();
		delete (data.layout as Record<string, unknown>).bounds;
		expect(() => parseLayout(data)).toThrow(/缺少 bounds/);
	});

	it("bounds 非 object 抛错", () => {
		const data = validLayout();
		(data.layout as Record<string, unknown>).bounds = 42;
		expect(() => parseLayout(data)).toThrow(/缺少 bounds/);
	});

	it("bounds 缺字段抛错", () => {
		const data = validLayout();
		delete (data.layout as Record<string, unknown>).bounds;
		(data.layout as Record<string, unknown>).bounds = { x: 0, y: 0, width: 10 };
		expect(() => parseLayout(data)).toThrow();
	});

	it("handle 缺失抛错", () => {
		const data = validLayout();
		delete (data.layout as Record<string, unknown>).handle;
		expect(() => parseLayout(data)).toThrow();
	});

	it("revision 非数字抛错", () => {
		const data = validLayout();
		(data.layout as Record<string, unknown>).revision = "3";
		expect(() => parseLayout(data)).toThrow();
	});
});
