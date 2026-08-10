// ============================================================
// changePatch — 变更文件级重放合并
//
// 变更面板（本轮变更）的数据源：把同一文件在一轮会话里的所有
// write/edit 操作按顺序重放，得到「操作前 → 操作后」的精确
// unified patch + 统计，保证卡片上的 +N -M 与查看器渲染完全一致。
//
// 语义：
//   - 首操作是 write（新建文件）→ base 为空串，后续 edit 用
//     oldText→newText 在内容上替换，最终 diff 精确（行级）。
//   - 首操作是 edit（修改已有文件）→ base 未知（工具 patch 不
//     含原文件全文），退化为「行序列合并」：按操作顺序收集所有
//     -old +new 行，内容完整但行号从 1 开始（近似）。
//   - oldText 匹配失败（文件可能被外部修改/顺序异常）→ 标记
//     unmatched，统计标为不可靠（UI 隐藏 +/−，保留打开能力）。
// ============================================================

import { type DiffLine, lineDiff } from "./lineDiff";

const EDIT_TOOLS = new Set(["edit", "apply_diff", "apply_patch", "modify"]);
const WRITE_TOOLS = new Set(["write", "create"]);

export interface FileOperation {
	tool: string;
	args: Record<string, unknown>;
	/**
	 * SDK result 携带的工具 patch（extractEditPatch 提取）。当 args.edits 为空
	 * （如 apply_diff 只把 patch 放 result）时，用它作为该操作的变更内容。
	 */
	patchFallback?: string;
}

export interface ReplayedPatch {
	patch: string;
	added: number;
	deleted: number;
	/** 存在 edit 的 oldText 匹配失败（外部修改/顺序异常）→ 内容/统计不完全可靠。 */
	unmatched: boolean;
	/**
	 * 仅首操作 edit（base 未知）且多次操作时：统计是“操作行数”而非净变化
	 * （中间态行会计入），UI 应隐藏 +/−（statsReliable=false）。
	 */
	approximate?: boolean;
}

function isEditTool(tool: string): boolean {
	return EDIT_TOOLS.has(tool.toLowerCase());
}

function isWriteTool(tool: string): boolean {
	return WRITE_TOOLS.has(tool.toLowerCase());
}

/** 在 content 中替换第一个 oldText 匹配为 newText；找不到返回原内容 + matched=false。 */
function applyEditContent(content: string, oldText: string, newText: string): { content: string; matched: boolean } {
	if (oldText.length === 0) {
		// 空 oldText = 纯插入：插入点由工具参数决定，patch 侧无法复原，按追加近似处理。
		return { content: content + newText, matched: true };
	}
	const index = content.indexOf(oldText);
	if (index === -1) return { content, matched: false };
	return {
		content: content.slice(0, index) + newText + content.slice(index + oldText.length),
		matched: true,
	};
}

/** lineDiff 结果 → unified patch（行号从 1 开始的简化 hunk）+ 精确统计。 */
function patchFromLineDiff(path: string, lines: DiffLine[]): { patch: string; added: number; deleted: number } {
	let added = 0;
	let deleted = 0;
	const body: string[] = [];
	for (const line of lines) {
		if (line.kind === "del") {
			body.push(`-${line.text}`);
			deleted++;
		} else if (line.kind === "add") {
			body.push(`+${line.text}`);
			added++;
		} else {
			body.push(` ${line.text}`);
		}
	}
	const oldCount = lines.filter((l) => l.kind !== "add").length;
	const newCount = lines.filter((l) => l.kind !== "del").length;
	// 新建文件（oldCount=0）用标准 hunk 头 -0,0，避免渲染器画幻影空删除行。
	const patch = [
		`--- ${path}`,
		`+++ ${path}`,
		`@@ -${oldCount || 0},${oldCount || 0} +1,${newCount || 1} @@`,
		...body,
	].join("\n");
	return { patch, added, deleted };
}

/** base 未知（首操作即 edit）时的回退：按顺序收集所有 -old +new 行。 */
function mergeLines(path: string, operations: FileOperation[]): ReplayedPatch {
	const body: string[] = [];
	let added = 0;
	let deleted = 0;
	for (const op of operations) {
		const args = op.args;
		if (isWriteTool(op.tool) && typeof args.content === "string") {
			const lines = args.content.split("\n");
			if (lines.at(-1) === "") lines.pop();
			for (const line of lines) {
				body.push(`+${line}`);
				added++;
			}
		} else if (isEditTool(op.tool)) {
			if (!Array.isArray(args.edits) || args.edits.length === 0) {
				// args 无 edits（patch 在 SDK result）→ 用 fallback patch 的原始 +/- 行
				if (!op.patchFallback) continue;
				for (const line of op.patchFallback.split(/\r?\n/)) {
					if (line.startsWith("+") && !line.startsWith("+++")) {
						body.push(line);
						added++;
					} else if (line.startsWith("-") && !line.startsWith("---")) {
						body.push(line);
						deleted++;
					}
				}
				continue;
			}
			for (const edit of args.edits as Array<{ oldText?: unknown; newText?: unknown }>) {
				const oldText = typeof edit?.oldText === "string" ? edit.oldText : "";
				const newText = typeof edit?.newText === "string" ? edit.newText : "";
				const oldLines = oldText.length > 0 ? oldText.split("\n") : [];
				if (oldLines.at(-1) === "") oldLines.pop();
				const newLines = newText.length > 0 ? newText.split("\n") : [];
				if (newLines.at(-1) === "") newLines.pop();
				for (const line of oldLines) {
					body.push(`-${line}`);
					deleted++;
				}
				for (const line of newLines) {
					body.push(`+${line}`);
					added++;
				}
			}
		}
	}
	const patch = [`--- ${path}`, `+++ ${path}`, `@@ -1,${deleted || 0} +1,${added || 1} @@`, ...body].join("\n");
	// 仅首操作 edit（base 未知）且多次操作时统计为操作行数（含中间态），标记近似。
	return { patch, added, deleted, unmatched: false, approximate: operations.length > 1 };
}

/**
 * 把同一文件的多个操作重放为完整 patch + 统计。
 *
 * @param path   显示用路径（patch 头 a/b 使用）
 * @param operations 本轮该文件的所有 write/edit 操作（按时间顺序）
 * @returns 合并后的 patch 与统计；无有效操作时返回 null
 */
export function replayFileChanges(path: string, operations: FileOperation[]): ReplayedPatch | null {
	const effective = operations.filter((op) => isWriteTool(op.tool) || isEditTool(op.tool));
	if (effective.length === 0) return null;

	const first = effective[0];
	// 首操作是 write → 以 write 的第一版内容为基准重放：
	//   仅 write（无后续 edit）→ base 为空串（新建文件，全新增）；
	//   write + edit → base 为 write 版本，diff 展示 edit 的删除/新增（用户可见“改了哪几行”）。
	// 首操作不是 write（base 未知）→ 退化为行序列合并。
	if (!isWriteTool(first.tool)) {
		return mergeLines(path, effective);
	}

	let content = typeof first.args.content === "string" ? first.args.content : "";
	const hasLaterEdits = effective.slice(1).some((op) => isEditTool(op.tool));
	const base = hasLaterEdits ? content : "";
	const unmatched = false;
	for (let i = 1; i < effective.length; i++) {
		const op = effective[i];
		const args = op.args;
		if (isWriteTool(op.tool)) {
			content = typeof args.content === "string" ? args.content : content;
			continue;
		}
		if (!isEditTool(op.tool)) continue;
		const edits = Array.isArray(args.edits) ? args.edits : [];
		if (edits.length === 0) {
			// 该 edit 无法从 args 重放（patch 只在 SDK result）→ 整体降级为行序列合并，
			// 保证 write 的新增与 fallback 的删除/新增都可见。
			return mergeLines(path, effective);
		}
		for (const edit of edits as Array<{ oldText?: unknown; newText?: unknown }>) {
			const oldText = typeof edit?.oldText === "string" ? edit.oldText : "";
			const newText = typeof edit?.newText === "string" ? edit.newText : "";
			const applied = applyEditContent(content, oldText, newText);
			content = applied.content;
			if (!applied.matched) {
				// SDK 对 oldText 做模糊匹配（行尾空白/NFKC/智能引号等），精确 indexOf 可能失败；
				// 此时文件磁盘上已应用该 edit，降级为行序列合并，保证全部删除/新增可见
				// （不能静默丢弃该 edit 的变更）。
				return mergeLines(path, effective);
			}
		}
	}

	const fromDiff = patchFromLineDiff(path, lineDiff(base, content));
	return { ...fromDiff, unmatched };
}
