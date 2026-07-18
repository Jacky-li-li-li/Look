// ============================================================
// filePathDetection — 识别可点击的文件路径文本
//
// 用于 markdown inline code / 文件引用等场景:
// 只有"像路径"的文本才渲染为可点击按钮,点击后打开文件查看器。
// ============================================================

import type { ReactNode } from "react";

/** URL 协议前缀(https://、file:、mailto:),绝不视为文件路径 */
const SCHEME_PATTERN = /^(?:https?:\/\/|file:|mailto:)/i;

/** Windows 盘符路径前缀(C:\ 或 C:/) */
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:[\\/]/;

/** 文件扩展名:. + 1-10 个字母数字 */
const EXTENSION_PATTERN = /\.[A-Za-z0-9]{1,10}$/;

/**
 * 把 React children 拍平成纯文本。
 * streamdown 流式渲染时可能把同一段文本拆成字符串数组/嵌套数组。
 */
export function coalesceChildren(children: ReactNode): string {
	if (children == null || typeof children === "boolean") return "";
	if (typeof children === "string") return children;
	if (typeof children === "number") return String(children);
	if (Array.isArray(children)) return children.map(coalesceChildren).join("");
	return ""; // 元素等其他节点不参与路径检测
}

/**
 * 启发式判断文本是否"像文件路径"(可点击打开查看器):
 *   1. 去掉首尾空白后至少 2 个字符,且内部不含任何空白;
 *   2. 不带 URL 协议前缀(https?://、file:、mailto:);
 *   3. 必须以 /、~/ 或 Windows 盘符(X:\ 或 X:/)开头;
 *   4. 再满足其一:含 ≥2 个 /(有多级目录)、以扩展名结尾、
 *      或长度 >3 的 Windows 盘符路径。
 * 因此 /skill:commit、/、hello、a b/c.md 都不会被误判为路径。
 */
export function looksLikeFilePath(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length < 2) return false;
	if (/\s/.test(trimmed)) return false;
	if (SCHEME_PATTERN.test(trimmed)) return false;

	const isWindowsDrive = WINDOWS_DRIVE_PATTERN.test(trimmed);
	if (!trimmed.startsWith("/") && !trimmed.startsWith("~/") && !isWindowsDrive) return false;

	const slashCount = (trimmed.match(/\//g) ?? []).length;
	if (slashCount >= 2) return true;
	if (EXTENSION_PATTERN.test(trimmed)) return true;
	return isWindowsDrive && trimmed.length > 3;
}

/**
 * 解析为绝对路径:
 *   ~/x        → ${homedir}/x
 *   绝对路径    → 原样返回(posix 或 Windows 盘符)
 *   ./x + cwd  → 去掉 ./ 后拼接 ${projectCwd}/x
 *   相对 + cwd  → ${projectCwd}/${text}
 *   相对无 cwd  → 原样返回(由查看器展示错误态)
 */
export function resolveToAbsolutePath(text: string, homedir: string, projectCwd?: string | null): string {
	const trimmed = text.trim();
	if (trimmed.startsWith("~/")) {
		const home = homedir.replace(/[\\/]+$/, "");
		return home ? `${home}${trimmed.slice(1)}` : trimmed;
	}
	if (trimmed.startsWith("/") || WINDOWS_DRIVE_PATTERN.test(trimmed)) return trimmed;
	if (projectCwd) {
		const rel = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
		return `${projectCwd.replace(/[\\/]+$/, "")}/${rel}`;
	}
	return trimmed;
}
