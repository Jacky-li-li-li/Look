// ============================================================
// todo-parser — 纯函数：解析项目根目录 TODO.md → TodoItem[]
// ============================================================

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TodoItem } from "../shared/types.js";

/**
 * 解析项目根目录的 TODO.md。
 * @returns TodoItem[] 或 null（文件不存在/无 checkbox）
 */
export function parseTodoFile(cwd: string): TodoItem[] | null {
	const todoPath = join(cwd, "TODO.md");
	if (!existsSync(todoPath)) return null;

	let content: string;
	try {
		content = readFileSync(todoPath, "utf-8");
	} catch (err) {
		console.warn(`[TodoParser] Failed to read ${todoPath}:`, err);
		return null;
	}

	const items: TodoItem[] = [];
	let lineNum = 0;

	for (const line of content.split("\n")) {
		lineNum++;
		const doneMatch = line.match(/^\s*-\s*\[(x|X)\]\s+(.+)/);
		const todoMatch = line.match(/^\s*-\s*\[\s\]\s+(.+)/);

		if (doneMatch) {
			items.push({ text: doneMatch[2].trim(), done: true, line: lineNum });
		} else if (todoMatch) {
			items.push({ text: todoMatch[1].trim(), done: false, line: lineNum });
		}
	}

	return items.length > 0 ? items : null;
}
