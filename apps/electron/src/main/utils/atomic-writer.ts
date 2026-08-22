// ============================================================
// AtomicWriter — tmp + rename 原子写入工具
//
// 统一持久化层的 JSON / 文本 / Markdown 文件写入，确保
// 写入过程中崩溃不会产生损坏文件。替换各处散落的直接
// writeFileSync 调用。
//
// 临时文件名带 pid + UUID：多个写者（或本进程内并发写）
// 指向同一目标时互不覆盖对方的临时文件，rename 保持原子。
// ============================================================

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/** JSON 缩进：true / 缺省 = tab（Look 默认），数字 = 空格数，false = 压缩。 */
export type JsonIndent = boolean | number;

function ensureDir(filePath: string): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
}

function indentFor(pretty: JsonIndent | undefined): string | number | undefined {
	if (pretty === undefined || pretty === true) return "\t";
	if (pretty === false) return undefined;
	return pretty;
}

function temporaryPathFor(filePath: string): string {
	return `${filePath}.${process.pid}.${randomUUID()}.tmp`;
}

export function writeJsonFile(filePath: string, data: unknown, pretty: JsonIndent = true, mode?: number): void {
	ensureDir(filePath);
	const tmp = temporaryPathFor(filePath);
	try {
		fs.writeFileSync(tmp, JSON.stringify(data, null, indentFor(pretty)), { encoding: "utf8", mode });
		fs.renameSync(tmp, filePath);
	} finally {
		// rename 成功后临时文件已不存在，这里只清理失败残留。
		fs.rmSync(tmp, { force: true });
	}
}

export function writeTextFile(filePath: string, content: string): void {
	ensureDir(filePath);
	const tmp = temporaryPathFor(filePath);
	try {
		fs.writeFileSync(tmp, content, "utf8");
		fs.renameSync(tmp, filePath);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

/** 异步版原子写：供已 async 的调用方（store 队列、mcp 持久化等）使用。 */
export async function writeJsonFileAsync(
	filePath: string,
	data: unknown,
	pretty: JsonIndent = true,
	mode?: number,
): Promise<void> {
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	const tmp = temporaryPathFor(filePath);
	try {
		await fsp.writeFile(tmp, JSON.stringify(data, null, indentFor(pretty)), { encoding: "utf8", mode });
		await fsp.rename(tmp, filePath);
	} finally {
		await fsp.rm(tmp, { force: true }).catch(() => {});
	}
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

export function readJsonFileOptional<T>(filePath: string): T | null {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}
