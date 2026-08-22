// ============================================================
// fileViewerUtils — FileViewerDialog 的纯函数
//
// 路径展示与边界判断，无 React 依赖，可独立单测。
// ============================================================

/** Home dir injected by preload — used to shorten absolute paths to ~/…. */
const HOME_DIR = typeof window !== "undefined" ? (window.look?.homedir ?? "") : "";

/** 把绝对路径里的 $HOME 前缀替换为 ~（展示用）。 */
export function shortenPath(p: string): string {
	if (!p) return p;
	if (HOME_DIR && (p === HOME_DIR || p.startsWith(`${HOME_DIR}/`))) {
		return `~${p.slice(HOME_DIR.length)}`;
	}
	return p;
}

/** 中间省略截断长路径，保留首尾的目录与文件名信息。 */
export function truncateMiddle(text: string, max = 72): string {
	if (text.length <= max) return text;
	const half = Math.floor((max - 1) / 2);
	return `${text.slice(0, half)}…${text.slice(text.length - half)}`;
}

/** 路径归一化用于比较：统一斜杠、去尾斜、Windows 盘符小写。 */
export function normalizeComparablePath(value: string): string {
	const normalized = value.replace(/\\/g, "/");
	const trimmed = normalized === "/" ? normalized : normalized.replace(/\/$/, "");
	return /^[A-Za-z]:\//.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/** 判断 filePath 是否位于 projectCwd 内（词法比较，含大小写/斜杠归一化）。 */
export function isPathInsideProject(filePath: string, projectCwd: string): boolean {
	const candidate = normalizeComparablePath(filePath);
	const root = normalizeComparablePath(projectCwd);
	return Boolean(root) && (candidate === root || candidate.startsWith(`${root}/`));
}

/** 人类可读的文件大小：4 B / 12.4 KB / 1.2 MB / 3.1 GB。 */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}
