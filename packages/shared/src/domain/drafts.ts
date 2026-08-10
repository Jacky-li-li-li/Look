/**
 * Drafts — quick-capture sticky notes ("草稿").
 *
 * A draft is a single text note with a creation timestamp. Users capture
 * problems, ideas, or low-urgency follow-ups to avoid forgetting them, and
 * can later convert a draft into a live agent session in a chosen project.
 */

export interface Draft {
	id: string;
	/** Note body. Stored trimmed; must be non-empty. */
	text: string;
	/** Creation time, epoch milliseconds. */
	createdAt: number;
	/** 已转化为任务的会话 ID（转换成功即写入，用于“查看任务”跳转）。 */
	convertedSessionId?: string;
}

/** Draft 字段可更新项：正文与转化状态。 */
export interface DraftPatch {
	text?: string;
	convertedSessionId?: string | null;
}
