// ============================================================
// DraftStore — 草稿（quick-capture sticky notes）持久化
//
// 极简便签：单条文本 + 创建时间。参照 ScheduledTaskStore 的
// small atomic JSON store：readJsonFile 读 + writeJsonFile 原子写，
// mutation 队列串行化防止丢失更新。草稿不需要跨进程文件锁
// （定时任务才需要，草稿仅由本进程 UI 读写）。
// ============================================================

import { randomUUID } from "node:crypto";
import type { Draft, DraftPatch } from "@look/shared/types";
import { readJsonFile, writeJsonFile } from "../utils/atomic-writer.js";

interface DraftDatabase {
	version: 1;
	drafts: Draft[];
}

const EMPTY_DATABASE: DraftDatabase = { version: 1, drafts: [] };

/** 草稿文本长度上限（粘贴大段文本保护）。 */
export const DRAFT_MAX_TEXT_LENGTH = 4_000;

export class DraftStore {
	private database: DraftDatabase = structuredClone(EMPTY_DATABASE);
	private mutationQueue: Promise<void> = Promise.resolve();

	constructor(private readonly filePath: string) {}

	load(): void {
		const loaded = readJsonFile<DraftDatabase>(this.filePath, structuredClone(EMPTY_DATABASE));
		this.database = {
			version: 1,
			drafts: Array.isArray(loaded.drafts) ? loaded.drafts : [],
		};
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
		await this.mutate((database) => database.drafts.push(draft));
		return structuredClone(draft);
	}

	update(draftId: string, patch: DraftPatch): Promise<Draft> {
		return this.mutate((database) => {
			const draft = database.drafts.find((item) => item.id === draftId);
			if (!draft) throw new Error(`Draft not found: ${draftId}`);
			if (patch.text !== undefined) draft.text = sanitiseDraftText(patch.text);
			if (patch.convertedSessionId !== undefined) {
				draft.convertedSessionId = patch.convertedSessionId ?? undefined;
			}
		}).then(() => this.getDraft(draftId));
	}

	delete(draftId: string): Promise<void> {
		return this.mutate((database) => {
			const before = database.drafts.length;
			database.drafts = database.drafts.filter((item) => item.id !== draftId);
			if (database.drafts.length === before) throw new Error(`Draft not found: ${draftId}`);
		});
	}

	/** 串行化变更 + 落盘：加载最新文件 → 应用变更 → await 写盘完成。 */
	private async mutate(update: (database: DraftDatabase) => void): Promise<void> {
		this.load();
		const snapshot = structuredClone(this.database);
		update(snapshot);
		this.database = snapshot;
		this.mutationQueue = this.mutationQueue.then(() => {
			writeJsonFile(this.filePath, this.database);
		});
		await this.mutationQueue;
	}

	private getDraft(draftId: string): Draft {
		const draft = this.database.drafts.find((item) => item.id === draftId);
		if (!draft) throw new Error(`Draft not found: ${draftId}`);
		return structuredClone(draft);
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
