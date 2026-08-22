// ============================================================
// DraftStore — 草稿（quick-capture sticky notes）持久化
//
// 极简便签：单条文本 + 创建时间。基建（mutation 队列 +
// 跨进程文件锁 + 原子写）由 LockedJsonStore 提供，
// 这里只保留草稿特有的归一化与业务方法。
// ============================================================

import { randomUUID } from "node:crypto";
import type { Draft, DraftPatch } from "@look/shared/types";
import { LockedJsonStore } from "../utils/locked-json-store.js";

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

export class DraftStore extends LockedJsonStore<DraftDatabase> {
	constructor(filePath: string) {
		super(filePath, EMPTY_DATABASE, "DraftStore");
	}

	protected normalizeDatabase(raw: unknown): DraftDatabase {
		return normalizeDatabase(raw);
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
