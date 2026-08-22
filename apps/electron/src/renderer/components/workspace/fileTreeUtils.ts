// ============================================================
// fileTreeUtils — 文件树压平工具
//
// WorkspaceTreePanel 与 SharedAreaPanel 各自实现了近乎逐行复制的
// flattenTree + FlatRow + INDENT_PX。此处合并为单一事实源。
//
// FlatRow.parentPath 目前无消费方（WorkspaceTreePanel 解构后即弃置，
// 折叠停 watcher 走 node.path 判断）；保留字段是因为 trackParent
// 分支与旧实现逐行一致，未来做折叠优化时可直接启用。
// ============================================================

import type { FileTreeNode } from "@shared/types";

/** 缩进像素（两套面板原各自的常量值一致）。 */
export const INDENT_PX = 14;

/** 压平后的虚拟列表行。 */
export interface FlatRow {
	node: FileTreeNode;
	depth: number;
	/** 父目录相对路径，"" = 根。当前无消费方（见文件头注释）。 */
	parentPath?: string;
}

/**
 * 递归把树压平成线性行：展开的目录节点按 depth 缩进，子项紧跟其后。
 *
 * @param rootChildren 根目录的直接子项
 * @param expanded     展开路径集合
 * @param loaded       已加载子项缓存（parentPath → children）
 * @param trackParent  是否在每行记录 parentPath（WorkspaceTreePanel 需要）
 */
export function flattenTree(
	rootChildren: FileTreeNode[],
	expanded: Set<string>,
	loaded: Map<string, FileTreeNode[]>,
	trackParent = false,
): FlatRow[] {
	const rows: FlatRow[] = [];
	const walk = (children: FileTreeNode[], depth: number, parentPath: string) => {
		for (const node of children) {
			rows.push(trackParent ? { node, depth, parentPath } : { node, depth });
			if (node.type === "directory" && expanded.has(node.path)) {
				const grandChildren = loaded.get(node.path);
				if (grandChildren) walk(grandChildren, depth + 1, node.path);
			}
		}
	};
	walk(rootChildren, 0, "");
	return rows;
}
