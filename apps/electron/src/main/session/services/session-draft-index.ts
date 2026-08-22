// ============================================================
// SessionDraftIndex — 未落盘会话的最小草稿索引
//
// 借鉴 Proma 的 agent-sessions.json 设计，但收窄到最小职责：
// pi JSONL 仍是对话内容与历史的唯一真源（AGENTS.md 不变量不变），
// 本索引只承载「尚未写出会话文件的新建会话」的存在性、名称与时间，
// 解决两类问题：
//   1. 新建会话的乐观行在崩溃/重启后不可恢复（此前 process-local）；
//   2. 删除/失败/列表合并等场景对「无 stored 会话」的特殊分支。
// 会话文件一旦落盘（首个 assistant 消息触发 pi flush），条目即被
// prunePersisted 修剪——索引里永远只有真正未落盘的会话。
// ============================================================

import { statSync } from "node:fs";
import { getSessionDraftsIndexPath } from "@look/shared/look-storage";
import type { ImSessionProvider } from "@look/shared/types";
import { readJsonFile, writeJsonFile } from "../../utils/atomic-writer.js";

export interface SessionDraftEntry {
	/** pi 会话 ID（SessionManager.create 分配，重启恢复时用同 ID 重建）。 */
	id: string;
	projectId: string;
	name: string;
	imProvider?: ImSessionProvider;
	createdAt: number;
	updatedAt: number;
}

interface SessionDraftsFile {
	version: 1;
	entries: SessionDraftEntry[];
}

export class SessionDraftIndex {
	/** 读缓存（mtime+size 失效）：get/list 走侧栏热路径，避免每次读盘解析。 */
	private cache: { mtimeMs: number; size: number; file: SessionDraftsFile } | null = null;

	constructor(private readonly filePath: string = getSessionDraftsIndexPath()) {}

	private readFile(): SessionDraftsFile {
		let mtimeMs = 0;
		let size = -1;
		try {
			const stats = statSync(this.filePath);
			mtimeMs = stats.mtimeMs;
			size = stats.size;
		} catch {
			// 文件不存在 → 空索引（缓存之，避免热路径反复 stat 失败后还要尝试读取）。
			this.cache = null;
			return { version: 1, entries: [] };
		}
		if (this.cache && this.cache.mtimeMs === mtimeMs && this.cache.size === size) {
			return this.cache.file;
		}
		const fallback: SessionDraftsFile = { version: 1, entries: [] };
		const data = readJsonFile<SessionDraftsFile>(this.filePath, fallback);
		// 版本/结构防御：任何不合预期的形状都视为空索引，不抛出。
		const file: SessionDraftsFile =
			!data || !Array.isArray(data.entries) ? fallback : { version: 1, entries: data.entries };
		this.cache = { mtimeMs, size, file };
		return file;
	}

	private writeFile(data: SessionDraftsFile): void {
		writeJsonFile(this.filePath, data);
		// 写后失效：下次读取重新加载（也覆盖跨进程写入交错的情况）。
		this.cache = null;
	}

	list(projectId?: string): SessionDraftEntry[] {
		const entries = this.readFile().entries;
		const filtered = projectId ? entries.filter((entry) => entry.projectId === projectId) : entries;
		// 新的在前，与侧边栏排序直觉一致。
		return [...filtered].sort((a, b) => b.createdAt - a.createdAt);
	}

	get(sessionId: string): SessionDraftEntry | undefined {
		return this.readFile().entries.find((entry) => entry.id === sessionId);
	}

	add(entry: SessionDraftEntry): void {
		const data = this.readFile();
		if (data.entries.some((existing) => existing.id === entry.id)) return;
		data.entries.push(entry);
		this.writeFile(data);
	}

	remove(sessionId: string): void {
		const data = this.readFile();
		const next = data.entries.filter((entry) => entry.id !== sessionId);
		if (next.length === data.entries.length) return;
		this.writeFile({ version: 1, entries: next });
	}

	/** 修剪已落盘的会话：删除出现在 persistedIds 中的条目，返回修剪数量。 */
	prunePersisted(projectId: string, persistedIds: Set<string>): number {
		const data = this.readFile();
		const next = data.entries.filter((entry) => entry.projectId !== projectId || !persistedIds.has(entry.id));
		if (next.length === data.entries.length) return 0;
		this.writeFile({ version: 1, entries: next });
		return data.entries.length - next.length;
	}
}
