// ============================================================
// File router — direct file read/write for the renderer
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { getProjectSharedDir } from "@look/shared/look-storage";
import { isSensitivePath } from "../../security/sensitive-paths.js";
import { guardPath } from "../guards.js";
import type { IpcRouter } from "../invoke-context.js";

/**
 * Resolve a user-supplied path and assert it lives inside at least one of the
 * allowed project roots. Prevents the renderer from reading/writing arbitrary
 * files (~/.ssh/*, ~/.look/auth.json, ...) if the renderer process is ever
 * compromised. Uses realpath so symlinks pointing outside the roots are
 * rejected too (best effort: for not-yet-existing files realpath fails and we
 * fall back to the lexical path check).
 */
/**
 * 只读路径守卫:基本校验 + 敏感路径拦截(2026-08-08 方案 B 保留项目外只读,
 * 但 ~/.ssh、dotfile、LOOK_HOME 凭据区、macOS ~/Library 关键目录一律拒绝)。
 * 已存在的路径再对 realpath 复核一次(防 symlink 指向敏感区后经 open() 跟随读取)。
 */
async function guardAnyPath(rawPath: unknown, label: string): Promise<string> {
	const resolved = guardPath(rawPath, label);
	// 词法检查:路径本身落在敏感区(含尚未创建的探测目标)
	if (isSensitivePath(resolved)) {
		throw new Error(`Path denied for ${label}: sensitive location`);
	}
	// realpath 复核:已存在路径经 symlink 解析后落入敏感区同样拒绝
	try {
		const real = await fs.promises.realpath(resolved);
		if (real !== resolved && isSensitivePath(real)) {
			throw new Error(`Path denied for ${label}: symlink resolves to a sensitive location`);
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Path denied")) throw error;
		// ENOENT 等:目标不存在,词法检查已通过
	}
	return resolved;
}

/**
 * 写入路径守卫:必须在至少一个项目根内(含共享区),symlink 逃逸同样拒绝。
 * file:write 保持严格限制 —— 项目外文件不可写。
 */
async function guardProjectPath(rawPath: unknown, label: string, projectRoots: string[]): Promise<string> {
	const resolved = guardPath(rawPath, label);
	const roots = projectRoots.filter((root) => typeof root === "string" && root.length > 0);
	if (roots.length === 0) {
		throw new Error(`Path denied for ${label}: no allowed project directories are configured`);
	}
	if (!isInsideAnyRoot(resolved, roots)) {
		throw new Error(`Path denied for ${label}: outside allowed project directories`);
	}
	// Reject symlinks that escape the allowed roots.
	try {
		const real = await fs.promises.realpath(resolved);
		if (!isInsideAnyRoot(real, roots)) {
			throw new Error(`Path denied for ${label}: symlink escapes allowed project directories`);
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Path denied")) throw error;
		// ENOENT etc.: file may not exist yet (write); lexical check already passed.
	}
	return resolved;
}

/** 路径是否位于任一根目录内(词法判断)。 */
export function isInsideAnyRoot(p: string, roots: string[]): boolean {
	const effective = roots.filter((root) => typeof root === "string" && root.length > 0);
	return effective.some((root) => {
		const rel = path.relative(root, p);
		return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
	});
}

/** 读取上限 4MB,超出部分截断返回。 */
const FILE_READ_MAX_BYTES = 4 * 1024 * 1024;
/** 写入上限 10MB(guardString 的 100KB 上限太小,这里手动校验字节数)。 */
const FILE_WRITE_MAX_BYTES = 10 * 1024 * 1024;
/** 二进制嗅探窗口:前 8KB 内出现 NUL 字节即视为二进制文件。 */
const BINARY_SNIFF_BYTES = 8 * 1024;
/** 图片预览读取上限 20MB(base64 后约 27MB,IPC 可承受);超出回退二进制提示。 */
const IMAGE_READ_MAX_BYTES = 20 * 1024 * 1024;
/**
 * 可预览图片的扩展名 → MIME。svg 以 <img> data URI 渲染，
 * 图片上下文不执行脚本，可安全预览。
 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".avif": "image/avif",
	".svg": "image/svg+xml",
};

/** 文件内容读取的底层结果(不含 inProject,由 router 层按路径归属附加)。 */
export type FileReadContentResult =
	| { success: true; kind: "text"; content: string; truncated: boolean; sizeBytes: number }
	| { success: true; kind: "image"; data: string; mimeType: string; sizeBytes: number }
	| { success: true; kind: "binary"; sizeBytes: number };

export type FileReadResult = FileReadContentResult & { inProject: boolean };

export type PathStatContentResult = Omit<PathStatResult, "inProject">;

export interface FileWriteResult {
	success: true;
	sizeBytes: number;
}

/** 读取文件内容:>4MB 只读前 4MB 并标记截断;前 8KB 含 NUL 字节视为二进制,不解码。 */
export async function readFileContent(filePath: string): Promise<FileReadContentResult> {
	const stat = await fs.promises.lstat(filePath);
	if (!stat.isFile()) {
		throw new Error(`Not a file: ${filePath}`);
	}
	const sizeBytes = stat.size;
	// 图片扩展名优先于二进制嗅探:png/jpg 等会被 NUL 规则判成二进制，
	// svg 是文本但同样应预览为图片。超过 20MB 回退"二进制不可预览"。
	const imageMime = IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()];
	if (imageMime && sizeBytes <= IMAGE_READ_MAX_BYTES) {
		const buffer = await fs.promises.readFile(filePath);
		return { success: true, kind: "image", data: buffer.toString("base64"), mimeType: imageMime, sizeBytes };
	}
	const truncated = sizeBytes > FILE_READ_MAX_BYTES;
	const length = Math.min(sizeBytes, FILE_READ_MAX_BYTES);
	const handle = await fs.promises.open(filePath, "r");
	try {
		const buffer = Buffer.alloc(length);
		if (length > 0) {
			await handle.read(buffer, 0, length, 0);
		}
		if (buffer.subarray(0, Math.min(length, BINARY_SNIFF_BYTES)).includes(0)) {
			return { success: true, kind: "binary", sizeBytes };
		}
		return { success: true, kind: "text", content: buffer.toString("utf8"), truncated, sizeBytes };
	} finally {
		await handle.close();
	}
}

/** 写入 utf8 文本:>10MB 拒绝;路径已存在且是目录时拒绝;不创建父目录。 */
export async function writeFileContent(filePath: string, content: string): Promise<FileWriteResult> {
	const sizeBytes = Buffer.byteLength(content, "utf8");
	if (sizeBytes > FILE_WRITE_MAX_BYTES) {
		throw new Error(`Invalid content: exceeds max size ${FILE_WRITE_MAX_BYTES} bytes`);
	}
	const existing = await fs.promises.lstat(filePath).catch(() => null);
	if (existing?.isDirectory()) {
		throw new Error(`Cannot write to directory path: ${filePath}`);
	}
	await fs.promises.writeFile(filePath, content, "utf8");
	return { success: true, sizeBytes };
}

/** 路径类型探测:点击文件路径芯片前先 stat,目录改走 Finder 展示,不打开查看器。 */
export type PathKind = "file" | "directory" | "other" | "missing";

export interface PathStatResult {
	success: true;
	kind: PathKind;
	/** 路径是否位于任一项目根(含共享区)内:渲染端据此禁用项目外文件的编辑/保存。 */
	inProject: boolean;
}

export async function statPathKind(filePath: string): Promise<PathStatContentResult> {
	// 使用 stat(而非 lstat)跟随符号链接:指向目录的软链也按目录分类,以便在 Finder 中展示。
	const stat = await fs.promises.stat(filePath).catch(() => null);
	if (!stat) return { success: true, kind: "missing" };
	if (stat.isDirectory()) return { success: true, kind: "directory" };
	if (!stat.isFile()) return { success: true, kind: "other" };
	return { success: true, kind: "file" };
}

export const fileRouter: IpcRouter = (ctx, register) => {
	// Allowed roots: every project cwd plus each project's shared area
	// (~/.look/shared/<projectId>). Keeping the shared area inside the allowlist
	// preserves the shared-file viewer without opening arbitrary home paths.
	const projectRoots = () => ctx.project.service.listProjects().flatMap((p) => [p.cwd, getProjectSharedDir(p.id)]);

	register("file:read", async (data) => {
		const filePath = await guardAnyPath(data.path, "path");
		const result = await readFileContent(filePath);
		return { ...result, inProject: isInsideAnyRoot(filePath, projectRoots()) };
	});

	register("file:write", async (data) => {
		const filePath = await guardProjectPath(data.path, "path", projectRoots());
		const content: unknown = data.content;
		if (typeof content !== "string") {
			throw new Error(`Invalid content: expected string, got ${typeof content}`);
		}
		return writeFileContent(filePath, content);
	});

	register("file:stat", async (data) => {
		const filePath = await guardAnyPath(data.path, "path");
		const result = await statPathKind(filePath);
		return { ...result, inProject: isInsideAnyRoot(filePath, projectRoots()) };
	});
};
