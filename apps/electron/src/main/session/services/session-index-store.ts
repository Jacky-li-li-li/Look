// ============================================================
// SessionIndexStore — 持久化会话索引（Proma 式单文件索引）
//
// 目标：应用重启/刷新后侧边栏秒开——跳过逐个打开 JSONL 的
// SessionManager.list（每项目 30ms+），直接从索引文件恢复会话
// 元数据。目录指纹（文件数 + 最大 mtime）变化时才触发全量重扫。
//
// 正确性：指纹基于文件 mtime（内容追加/删除/新建必然改变 mtime，
// 是内容变化的超集），索引与真实目录不一致时 fingerprint 不匹配
// → 自动全量重扫并重建索引（自愈）。索引文件损坏/缺失 → 全量重扫。
//
// 索引只持久化渲染端消费的字段（id/name/firstMessage/messageCount/
// created/modified/cwd/path/projectId/parentSessionId/subagentAgentName），
// 丢弃 SDK list 返回的 allMessagesText 等体积字段。
// ============================================================

import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getWorkspaceDir } from "@look/shared/look-storage";
import type { StoredSession } from "./session-catalog.js";

/** 索引版本：v2 起子会话 path 使用真实文件路径（v1 拼接 <sessionId>.jsonl 无时间戳，
 *  会导致 SessionManager.open 误生成新会话）。版本不符 → 全量重扫重建。 */
const INDEX_VERSION = 2;
const INDEX_FILE_NAME = "sessions-index.json";

/** 索引持久化的会话字段（StoredSession 的瘦身子集）。 */
interface IndexedSession {
	id: string;
	name: string;
	firstMessage: string;
	messageCount: number;
	created: number;
	modified: number;
	cwd: string;
	path: string;
	projectId: string;
	parentSessionId?: string;
	subagentAgentName?: string;
}

interface SessionIndexFile {
	version: number;
	/** 目录指纹：`count:maxMtimeMs`（见 computeSessionsFingerprint）。 */
	fingerprint: string;
	sessions: IndexedSession[];
}

export interface SessionIndexSnapshot {
	fingerprint: string;
	sessions: StoredSession[];
}

/**
 * 轻量目录指纹：readdir + stat 每个 JSONL 文件，不打开文件内容。
 *
 * `count:maxMtimeMs` 语义：
 * - 会话新建/删除 → count 变化；
 * - 消息追加 / 重命名 / 任何内容写入 → 文件 mtime 变化。
 * 与 SDK list 的 modified（来自 JSONL 内容活动时间）不同，stat mtime
 * 是内容变化的可靠超集，指纹不匹配只会导致一次多余的全量重扫，不会
 * 漏更新。
 */
export async function computeSessionsFingerprint(sessionsDir: string, subsessionsDir: string | null): Promise<string> {
	let count = 0;
	let maxMtimeMs = 0;

	for (const dir of [sessionsDir, subsessionsDir]) {
		if (!dir || !existsSync(dir)) continue;
		let files: string[];
		try {
			files = (await fsp.readdir(dir)).filter((file) => file.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const file of files) {
			count += 1;
			try {
				const stats = await fsp.stat(path.join(dir, file));
				if (stats.mtimeMs > maxMtimeMs) maxMtimeMs = stats.mtimeMs;
			} catch {
				// 文件并发删除（会话清理）——忽略，指纹可能短暂偏差，
				// 下次 refresh 会重新计算。
			}
		}
	}

	return count === 0 ? "0" : `${count}:${Math.round(maxMtimeMs)}`;
}

export class SessionIndexStore {
	private indexPath(projectId: string): string {
		return path.join(getWorkspaceDir(projectId), INDEX_FILE_NAME);
	}

	/** 读取索引快照；文件缺失/损坏/版本不符返回 null（调用方全量重扫）。 */
	async load(projectId: string): Promise<SessionIndexSnapshot | null> {
		try {
			const raw = await fsp.readFile(this.indexPath(projectId), "utf8");
			const data = JSON.parse(raw) as SessionIndexFile;
			if (!data || data.version !== INDEX_VERSION || !Array.isArray(data.sessions)) return null;
			const sessions = data.sessions
				.filter((s) => typeof s.id === "string" && s.id.length > 0)
				.map(
					(s): StoredSession => ({
						...s,
						allMessagesText: "",
						created: new Date(s.created),
						modified: new Date(s.modified),
					}),
				);
			return { fingerprint: data.fingerprint, sessions };
		} catch {
			return null;
		}
	}

	/** 原子写入索引快照（tmp + rename）；失败静默（下次 refresh 重扫重建）。 */
	async save(projectId: string, snapshot: SessionIndexSnapshot): Promise<void> {
		const data: SessionIndexFile = {
			version: INDEX_VERSION,
			fingerprint: snapshot.fingerprint,
			sessions: snapshot.sessions.map((s) => ({
				id: s.id,
				name: s.name ?? "",
				firstMessage: s.firstMessage,
				messageCount: s.messageCount,
				created: s.created.getTime(),
				modified: s.modified.getTime(),
				cwd: s.cwd,
				path: s.path,
				projectId: s.projectId,
				parentSessionId: s.parentSessionId,
				subagentAgentName: s.subagentAgentName,
			})),
		};
		const tmpPath = `${this.indexPath(projectId)}.tmp-${process.pid}`;
		try {
			await fsp.writeFile(tmpPath, JSON.stringify(data), "utf8");
			await fsp.rename(tmpPath, this.indexPath(projectId));
		} catch (error) {
			console.error(`[Look][SessionIndex] Failed to write index for ${projectId}:`, error);
			await fsp.rm(tmpPath, { force: true }).catch(() => {});
		}
	}
}
