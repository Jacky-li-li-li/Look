// ============================================================
// DraftStore — 草稿（quick-capture sticky notes）持久化
//
// 极简便签：单条文本 + 创建时间。参照 ScheduledTaskStore 的
// small atomic JSON store：readJsonFile 读 + 唯一临时文件原子写，
// mutation 队列串行化，并用文件锁合并跨进程写入。
// ============================================================

import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Draft, DraftPatch } from "@look/shared/types";
import { type AcquiredTaskLock, FileTaskLock } from "../scheduler/task-lock.js";
import { readJsonFile } from "../utils/atomic-writer.js";

interface DraftDatabase {
	version: 1;
	drafts: Draft[];
}

const EMPTY_DATABASE: DraftDatabase = { version: 1, drafts: [] };

/** 草稿文本长度上限（粘贴大段文本保护）。 */
export const DRAFT_MAX_TEXT_LENGTH = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 丢弃坏条目而不是让一个损坏草稿拖垮整个列表。 */
function normalizeDraft(value: unknown): Draft | null {
	if (!isRecord(value)) return null;
	if (typeof value.id !== "string" || !value.id.trim()) return null;
	if (typeof value.text !== "string") return null;
	if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return null;

	const text = value.text.trim();
	if (!text || text.length > DRAFT_MAX_TEXT_LENGTH) return null;

	const convertedSessionId = value.convertedSessionId;
	if (
		convertedSessionId !== undefined &&
		convertedSessionId !== null &&
		(typeof convertedSessionId !== "string" || !convertedSessionId.trim())
	) {
		return null;
	}

	return {
		id: value.id,
		text,
		createdAt: value.createdAt,
		...(typeof convertedSessionId === "string" && convertedSessionId.trim()
			? { convertedSessionId: convertedSessionId.trim() }
			: {}),
	};
}

function normalizeDatabase(value: unknown): DraftDatabase {
	if (!isRecord(value) || !Array.isArray(value.drafts)) return structuredClone(EMPTY_DATABASE);
	return {
		version: 1,
		drafts: value.drafts.map(normalizeDraft).filter((draft): draft is Draft => draft !== null),
	};
}

export class DraftStore {
	private database: DraftDatabase = structuredClone(EMPTY_DATABASE);
	private mutationQueue: Promise<void> = Promise.resolve();
	private readonly mutationLock: FileTaskLock;

	constructor(private readonly filePath: string) {
		this.mutationLock = new FileTaskLock(`${filePath}.locks`, `${process.pid}:${randomUUID()}`);
	}

	load(): void {
		this.database = normalizeDatabase(readJsonFile<unknown>(this.filePath, null));
	}

	/** 全部草稿，按创建时间倒序（最新在前；同一毫秒内按插入倒序）。 */
	list(): Draft[] {
		this.load();
		return structuredClone(
			this.database.drafts
				.map((draft, index) => ({ draft, index }))
				.sort((a, b) => b.draft.createdAt - a.draft.createdAt || b.index - a.index)
				.map(({ draft }) => draft),
		);
	}

	async create(text: string): Promise<Draft> {
		const draft: Draft = { id: randomUUID(), text: sanitiseDraftText(text), createdAt: Date.now() };
		return this.mutate((database) => {
			database.drafts.push(draft);
			return structuredClone(draft);
		});
	}

	update(draftId: string, patch: DraftPatch): Promise<Draft> {
		return this.mutate((database) => {
			const draft = database.drafts.find((item) => item.id === draftId);
			if (!draft) throw new Error(`Draft not found: ${draftId}`);
			if (patch.text !== undefined) draft.text = sanitiseDraftText(patch.text);
			if (patch.convertedSessionId !== undefined) {
				draft.convertedSessionId = patch.convertedSessionId ?? undefined;
			}
			return structuredClone(draft);
		});
	}

	delete(draftId: string): Promise<void> {
		return this.mutate((database) => {
			const before = database.drafts.length;
			database.drafts = database.drafts.filter((item) => item.id !== draftId);
			if (database.drafts.length === before) throw new Error(`Draft not found: ${draftId}`);
		});
	}

	/** 串行化变更 + 落盘：队列内加载最新文件、应用变更并等待写盘完成。 */
	private async mutate<T>(update: (database: DraftDatabase) => T): Promise<T> {
		const operation = this.mutationQueue.then(async () => {
			const lock = await this.acquireMutationLock();
			try {
				// 刷新必须位于跨进程临界区内，避免多个 Look 实例互相覆盖。
				this.load();
				const next = structuredClone(this.database);
				const result = update(next);
				await this.writeDatabase(next);
				this.database = next;
				return result;
			} finally {
				await lock.release();
			}
		});

		// 当前调用仍然收到原始错误；队列本身吞掉错误，保证下一次 mutation 可以恢复。
		this.mutationQueue = operation
			.then(() => undefined)
			.catch((error) => {
				console.error("[DraftStore] Mutation failed:", error);
			});
		return operation;
	}

	private async acquireMutationLock(): Promise<AcquiredTaskLock> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const lock = await this.mutationLock.acquire("database", 30_000);
			if (lock) return lock;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`Timed out waiting for draft storage lock: ${this.filePath}`);
	}

	private async writeDatabase(database: DraftDatabase): Promise<void> {
		await mkdir(path.dirname(this.filePath), { recursive: true });
		const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporaryPath, JSON.stringify(database, null, "\t"), "utf8");
			await rename(temporaryPath, this.filePath);
		} finally {
			await rm(temporaryPath, { force: true }).catch(() => {});
		}
	}

	/** 等待所有待落盘写入完成（测试与退出前收尾用）。 */
	flush(): Promise<void> {
		return this.mutationQueue;
	}
}

/** 草稿文本规整：去除首尾空白、拒绝空文本、限制长度。 */
export function sanitiseDraftText(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("Draft text must not be empty");
	if (trimmed.length > DRAFT_MAX_TEXT_LENGTH) {
		throw new Error(`Draft text exceeds ${DRAFT_MAX_TEXT_LENGTH} characters`);
	}
	return trimmed;
}
