// ============================================================
// lineDiff — 行级文件对比（VSCode 风格完整文件 diff 视图）
//
// 简单贪心配对：按顺序匹配相同行，其余标记为删除/新增。
// 足够覆盖常见编辑场景（修改/新增/删除/插入）；不追求 Myers 最优。
// ============================================================

export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
	kind: DiffLineKind;
	text: string;
	/** 新文件行号（context/add 有效） */
	newLine?: number;
	/** 旧文件行号（context/del 有效） */
	oldLine?: number;
}

/** 逐行对比 old/new，返回 VSCode 风格的行列表（完整文件 + 变更标注）。 */
export function lineDiff(oldContent: string, newContent: string): DiffLine[] {
	const oldLines = oldContent.split("\n");
	if (oldLines.at(-1) === "") oldLines.pop();
	const newLines = newContent.split("\n");
	if (newLines.at(-1) === "") newLines.pop();

	const lines: DiffLine[] = [];
	let i = 0; // old index
	let j = 0; // new index
	while (i < oldLines.length || j < newLines.length) {
		// old 已消费完 → 剩余 new 全部为新增
		if (i >= oldLines.length) {
			lines.push({ kind: "add", text: newLines[j], newLine: j + 1 });
			j++;
			continue;
		}
		// new 已消费完 → 剩余 old 全部为删除
		if (j >= newLines.length) {
			lines.push({ kind: "del", text: oldLines[i], oldLine: i + 1 });
			i++;
			continue;
		}
		if (oldLines[i] === newLines[j]) {
			lines.push({ kind: "context", text: oldLines[i], oldLine: i + 1, newLine: j + 1 });
			i++;
			j++;
			continue;
		}
		// 尝试向前找相同行（配对）
		const lookahead = 50;
		let match = -1;
		for (let k = 1; k <= lookahead && j + k < newLines.length; k++) {
			if (oldLines[i] === newLines[j + k]) {
				match = k;
				break;
			}
		}
		if (match > 0) {
			// new 侧新增了 match 行
			for (let k = 0; k < match; k++) {
				lines.push({ kind: "add", text: newLines[j + k], newLine: j + k + 1 });
			}
			j += match;
		} else {
			// old 侧删除
			lines.push({ kind: "del", text: oldLines[i], oldLine: i + 1 });
			i++;
		}
	}
	return lines;
}
