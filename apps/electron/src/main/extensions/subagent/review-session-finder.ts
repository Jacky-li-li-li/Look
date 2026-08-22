// ============================================================
// ReviewSessionFinder — 查找父会话已绑定的审核子会话
//
// 从 subagent-router 下沉的域逻辑：按 delegation 记录匹配
// （parentSessionId + `Agent：<title>`），取最近创建的一个。
// 子会话由主 Agent 通过 subagent 工具创建后，delegation 记录
// 写在其 JSONL 中；磁盘扫描保证重启后依然命中。
//
// 注意：轮次隔离依赖渲染端把 turnKey 编入 title（如
// 「审核本轮变更 (entry-xxx)」）——同名 title 会命中最近一次
// 同名审核会话。
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { getWorkspaceSubsessionsDir } from "@look/shared/look-storage";

/** 子会话 delegation 记录类型（main 侧 session-catalog 常量）。 */
const DELEGATION_ENTRY_TYPE = "look.delegation.v1";

/**
 * 审核查询结果的内存缓存（TTL 10s）：避免重复点击审核时反复全量扫描
 * 子会话目录（每次都要逐行解析所有子会话 JSONL，子会话多时成本明显）。
 * key = `${parentSessionId}:${turnKey}`，轮次变化天然不命中。
 */
const reviewLookupCache = new Map<string, { childSessionId: string | null; at: number }>();
const REVIEW_LOOKUP_TTL_MS = 10_000;

/** 审核子会话命名（渲染端 delegation 匹配依赖此前缀，改动需同步）。 */
export const REVIEW_TITLE = "审核本轮变更";

/**
 * 查找父会话已绑定的审核子会话（防重复创建）。
 * @param getStoredSession 由调用方提供的 catalog 查询（窄端口）。
 * @param agentName 渲染端拼好的 delegation agent 名（如 `Agent：审核本轮变更`）。
 */
export async function findExistingReviewSession(
	parentSessionId: string,
	turnKey: string,
	agentName: string,
	getStoredSession: (sessionId: string) => { projectId: string } | undefined,
): Promise<string | null> {
	const cacheKey = `${parentSessionId}:${turnKey}`;
	const cached = reviewLookupCache.get(cacheKey);
	if (cached && Date.now() - cached.at < REVIEW_LOOKUP_TTL_MS) return cached.childSessionId;

	const stored = getStoredSession(parentSessionId);
	if (!stored) {
		reviewLookupCache.set(cacheKey, { childSessionId: null, at: Date.now() });
		return null;
	}
	const subsessionsDir = getWorkspaceSubsessionsDir(stored.projectId);
	let files: string[] = [];
	try {
		files = (await fs.promises.readdir(subsessionsDir)).filter((file) => file.endsWith(".jsonl"));
	} catch {
		reviewLookupCache.set(cacheKey, { childSessionId: null, at: Date.now() });
		return null;
	}

	let fallback: { childSessionId: string; createdAt: string } | null = null;
	for (const file of files) {
		const delegation = await readReviewDelegation(path.join(subsessionsDir, file), parentSessionId, agentName);
		if (delegation && (!fallback || delegation.createdAt > fallback.createdAt)) {
			fallback = delegation;
		}
	}
	const result = fallback?.childSessionId ?? null;
	reviewLookupCache.set(cacheKey, { childSessionId: result, at: Date.now() });
	return result;
}

/** 从子会话 JSONL 读取匹配 (parentSessionId, agentName) 的最新 delegation 记录。 */
async function readReviewDelegation(
	filePath: string,
	parentSessionId: string,
	agentName: string,
): Promise<{ childSessionId: string; createdAt: string } | null> {
	let content: string;
	try {
		content = await fs.promises.readFile(filePath, "utf-8");
	} catch {
		return null;
	}
	let latest: { childSessionId: string; createdAt: string } | null = null;
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let entry: { type?: string; customType?: string; data?: Record<string, unknown> };
		try {
			entry = JSON.parse(line) as { type?: string; customType?: string; data?: Record<string, unknown> };
		} catch {
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== DELEGATION_ENTRY_TYPE) continue;
		const data = entry.data;
		if (
			typeof data?.parentSessionId === "string" &&
			data.parentSessionId === parentSessionId &&
			typeof data.agentName === "string" &&
			data.agentName === agentName &&
			typeof data.childSessionId === "string" &&
			typeof data.createdAt === "string"
		) {
			if (!latest || data.createdAt > latest.createdAt) {
				latest = { childSessionId: data.childSessionId, createdAt: data.createdAt };
			}
		}
	}
	return latest;
}
