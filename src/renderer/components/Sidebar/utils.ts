// ============================================================
// Sidebar/utils — 纯工具函数
// ============================================================

export const SESSION_COLLAPSE_THRESHOLD = 5;

export function fmtRelativeTime(ts: number): string {
	const seconds = Math.floor((Date.now() - ts) / 1000);
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

export function shortenPath(cwd: string, homedir: string): string {
	return homedir && cwd.startsWith(homedir) ? `~${cwd.slice(homedir.length)}` : cwd;
}
