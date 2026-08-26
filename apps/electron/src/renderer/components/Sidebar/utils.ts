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

/**
 * 优先（需要注意）会话集合：运行中 / 刚完成 / 错误的会话及其父会话。
 * 刻意不含「当前选中」：选中是纯视图变化，不得改变折叠列表的行成员，
 * 否则切换会话时优先槽位转移，上一行瞬删、被顶出的行原地淡入（闪烁）。
 * 激活行的可见性由 ProjectTree 的激活展示 effect 用粘性展开保证。
 */
export function getPrioritySessionIds(
	sessions: readonly Pick<AgentInfo, "id" | "parentSessionId">[],
	runningAgents: ReadonlySet<string>,
	recentlyCompleted: readonly string[],
	errorAgentIds: ReadonlySet<string>,
): Set<string> {
	const ids = new Set<string>();
	for (const session of sessions) {
		const needsAttention =
			runningAgents.has(session.id) || recentlyCompleted.includes(session.id) || errorAgentIds.has(session.id);
		if (needsAttention) ids.add(session.parentSessionId ?? session.id);
	}
	return ids;
}

/** 折叠态可见窗口：优先会话全部保留，其余按传入顺序（createdAt 降序）补足至阈值。 */
export function getCollapsedVisibleSessions<T extends { id: string; createdAt: number }>(
	sortedTopLevel: readonly T[],
	prioritySessionIds: ReadonlySet<string>,
): T[] {
	const priorityCount = sortedTopLevel.filter((session) => prioritySessionIds.has(session.id)).length;
	const regularBudget = Math.max(0, SESSION_COLLAPSE_THRESHOLD - priorityCount);
	let regularShown = 0;
	return sortedTopLevel.filter((session) => {
		if (prioritySessionIds.has(session.id)) return true;
		if (regularShown < regularBudget) {
			regularShown += 1;
			return true;
		}
		return false;
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
