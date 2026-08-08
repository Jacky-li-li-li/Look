// ============================================================
// Sidebar/utils — 纯工具函数
// ============================================================

import type { AgentInfo } from "@shared/types";

export const SESSION_COLLAPSE_THRESHOLD = 5;

/**
 * 会话活动时间 = 内容落盘时间（lastActivityAt），无则回退创建时间。
 * 对齐 Proma：点击/查看不刷新该值，只有内容变化（写盘）才更新，
 * 因此排序稳定，不会因选中会话而跳位。
 */
export function getSessionActivityAt(session: Pick<AgentInfo, "createdAt" | "lastActivityAt">): number {
	return session.lastActivityAt ?? session.createdAt;
}

/** Return a new list ordered by the latest content change, newest first. */
export function sortSessionsByActivity<T extends Pick<AgentInfo, "createdAt" | "lastActivityAt">>(
	sessions: readonly T[],
): T[] {
	return [...sessions].sort((a, b) => {
		const activityDelta = getSessionActivityAt(b) - getSessionActivityAt(a);
		return activityDelta || b.createdAt - a.createdAt;
	});
}

/** Keep provider prefixes out of the narrow secondary line while preserving the full value for a tooltip. */
export function compactModelName(model: string): string {
	const value = model.trim();
	if (!value) return "";
	const separator = value.lastIndexOf("/");
	return separator >= 0 ? value.slice(separator + 1) : value;
}

export function fmtRelativeTime(ts: number, locale = "en", now = Date.now()): string {
	const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
	const elapsed = Math.max(0, now - ts);
	if (elapsed < 60_000) return formatter.format(0, "second");
	if (elapsed < 3_600_000) return formatter.format(-Math.floor(elapsed / 60_000), "minute");
	if (elapsed < 86_400_000) return formatter.format(-Math.floor(elapsed / 3_600_000), "hour");
	return formatter.format(-Math.floor(elapsed / 86_400_000), "day");
}

export function shortenPath(cwd: string, homedir: string): string {
	return homedir && cwd.startsWith(homedir) ? `~${cwd.slice(homedir.length)}` : cwd;
}
