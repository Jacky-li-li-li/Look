// ============================================================
// flattenTree 单测 — 文件树压平工具
//
// WorkspaceTreePanel 与 SharedAreaPanel 共享的虚拟列表行生成逻辑。
// ============================================================

import type { FileTreeNode } from "@shared/types";
import { describe, expect, it } from "vitest";
import { flattenTree, INDENT_PX } from "../../src/renderer/components/workspace/fileTreeUtils";

function file(name: string, path: string): FileTreeNode {
	return { name, path, absolutePath: `/root/${path}`, type: "file" };
}
function dir(name: string, path: string): FileTreeNode {
	return { name, path, absolutePath: `/root/${path}`, type: "directory" };
}

const TREE: FileTreeNode[] = [file("a.txt", "a.txt"), dir("src", "src"), file("b.md", "b.md")];

const SRC_CHILDREN: FileTreeNode[] = [file("index.ts", "src/index.ts"), dir("util", "src/util")];
const UTIL_CHILDREN: FileTreeNode[] = [file("helper.ts", "src/util/helper.ts")];

describe("flattenTree", () => {
	it("未展开时只输出根级行", () => {
		const rows = flattenTree(TREE, new Set(), new Map());
		expect(rows).toHaveLength(3);
		expect(rows.map((r) => r.node.name)).toEqual(["a.txt", "src", "b.md"]);
		expect(rows.every((r) => r.depth === 0)).toBe(true);
	});

	it("展开目录时递归输出子项，depth 递增", () => {
		const loaded = new Map([["src", SRC_CHILDREN]]);
		const rows = flattenTree(TREE, new Set(["src"]), loaded);
		// a.txt, src, src/index.ts, src/util, b.md
		expect(rows.map((r) => r.node.path)).toEqual(["a.txt", "src", "src/index.ts", "src/util", "b.md"]);
		expect(rows[0].depth).toBe(0);
		expect(rows[2].depth).toBe(1);
	});

	it("多层展开时 depth 正确递增", () => {
		const loaded = new Map([
			["src", SRC_CHILDREN],
			["src/util", UTIL_CHILDREN],
		]);
		const rows = flattenTree(TREE, new Set(["src", "src/util"]), loaded);
		expect(rows.map((r) => r.node.path)).toEqual([
			"a.txt",
			"src",
			"src/index.ts",
			"src/util",
			"src/util/helper.ts",
			"b.md",
		]);
		expect(rows[4].depth).toBe(2);
	});

	it("展开目录但未加载子项时不递归（跳过）", () => {
		const rows = flattenTree(TREE, new Set(["src"]), new Map());
		// src 展开但 loaded 无 src key → 不输出子项
		expect(rows.map((r) => r.node.path)).toEqual(["a.txt", "src", "b.md"]);
	});

	it("文件节点展开状态被忽略（不递归）", () => {
		const rows = flattenTree(TREE, new Set(["a.txt"]), new Map([["a.txt", [file("x", "x")]]]));
		expect(rows.map((r) => r.node.path)).toEqual(["a.txt", "src", "b.md"]);
	});

	it("trackParent=true 时记录 parentPath", () => {
		const loaded = new Map([["src", SRC_CHILDREN]]);
		const rows = flattenTree(TREE, new Set(["src"]), loaded, true);
		expect(rows[0].parentPath).toBe(""); // a.txt 在根
		expect(rows[1].parentPath).toBe(""); // src 在根
		expect(rows[2].parentPath).toBe("src"); // src/index.ts 的父是 src
		expect(rows[3].parentPath).toBe("src"); // src/util 的父是 src
	});

	it("trackParent=false 时 parentPath 为 undefined", () => {
		const loaded = new Map([["src", SRC_CHILDREN]]);
		const rows = flattenTree(TREE, new Set(["src"]), loaded, false);
		expect(rows[0].parentPath).toBeUndefined();
	});

	it("空树返回空数组", () => {
		expect(flattenTree([], new Set(), new Map())).toEqual([]);
	});
});

describe("INDENT_PX", () => {
	it("值为 14（两套面板一致）", () => {
		expect(INDENT_PX).toBe(14);
	});
});
