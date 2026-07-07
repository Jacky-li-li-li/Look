// ============================================================
// Path guard — 将「相对 root + 防越界 + 防 symlink 跨域」三段
// 校验从 v0.5 / v0.6 两个 service 中抽出,避免实现漂移。
//
// 调用方只需提供 root + 相对路径,本工具负责:
//   1. 拒绝绝对路径
//   2. 拒绝 ../ 越界(用 path.relative 跨平台统一处理)
//   3. realpath root(必须存在并解析成功)
//   4. realpath target(若存在):校验落在 root 内
//   5. ENOENT 回退:realpath parent,校验 parent 在 root 内
//      (目标可能正在被创建,这种情况下不能放过父目录越界)
//
// 为什么不用 `path.normalize(s).startsWith("..")`:
//   - Windows 上 normalize 后是 `\..\foo`,startsWith("..") 失效
//   - POSIX 上 `..foo` 是合法名字,startsWith("..") 误判
//   - path.relative 跨平台,处理 `..` 段为空时返回 `".."`
// ============================================================

import fs from "node:fs";
import path from "node:path";

export interface ResolveInsideRootOptions {
	/** 绝对路径,作为越界校验的边界。 */
	root: string;
	/** 错误信息中使用的根目录描述,例如 "shared area" / "workspace cwd"。 */
	rootName: string;
	/** 相对 `root` 的相对路径;空字符串表示 root 自身。 */
	relativePath: string;
}

/** realpath 的 ENOENT 安全版本:target 不存在时返回 null 而非抛错。 */
async function safeRealpath(p: string): Promise<string | null> {
	try {
		return await fs.promises.realpath(p);
	} catch (e) {
		if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
		// EACCES / ELOOP / ENOTDIR:由调用方决定如何处理
		throw e;
	}
}

/**
 * 解析并校验一个相对路径,确保其位于 `root` 之内(防 `../` 与 symlink 越界)。
 *
 * 返回值是 `path.resolve(root, normalized)` 的结果,不带 realpath —
 * 调用方如需在 target 不存在时也能拿到准确绝对路径,直接用返回值即可。
 */
export async function resolveInsideRoot(opts: ResolveInsideRootOptions): Promise<string> {
	const { root, rootName, relativePath } = opts;

	if (typeof relativePath !== "string") {
		throw new Error(`Invalid path for ${rootName}: not a string`);
	}
	if (path.isAbsolute(relativePath)) {
		throw new Error(`Path traversal detected (${rootName}): absolute path not allowed`);
	}

	const normalized = path.normalize(relativePath);
	// path.relative 在 normalized 越出 root 时返回以 ".." 开头的相对路径,
	// 跨平台行为一致(都使用 path.sep),比 startsWith("..") 更稳。
	const rel = path.relative(root, path.resolve(root, normalized));
	if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
		throw new Error(`Path traversal detected (${rootName})`);
	}

	const target = path.resolve(root, normalized);

	// root 必须存在并解析成功 — 调用方传过来的 root 应该是有效目录,
	// 如果不是,直接报错而不是默默接受任意路径。
	const realRoot = await safeRealpath(root);
	if (!realRoot) throw new Error(`${rootName} root unavailable`);

	const prefix = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
	const isInsideRoot = (resolved: string): boolean => resolved === realRoot || resolved.startsWith(prefix);

	const realTarget = await safeRealpath(target);
	if (realTarget) {
		if (!isInsideRoot(realTarget)) {
			throw new Error(`Path traversal detected (${rootName}): resolved outside ${rootName}`);
		}
		return target;
	}


	// target 不存在(可能正在被创建)。沿祖先链向上查找第一个存在的目录，
	// 校验它在 root 内，防御通过中间缺失目录中 symlink 的越界攻击。
	let ancestor = path.dirname(target);
	while (true) {
		const realAncestor = await safeRealpath(ancestor);
		if (realAncestor) {
			if (!isInsideRoot(realAncestor)) {
				throw new Error(`Path traversal detected (${rootName}): ancestor outside ${rootName}`);
			}
			break;
		}
		const parent = path.dirname(ancestor);
		if (parent === ancestor) break; // reached filesystem root
		ancestor = parent;
	}
	return target;
}
