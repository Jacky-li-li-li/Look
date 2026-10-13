import type { PersistedSessionRow } from "../../runtime-port/look-types.js";

/** 会话目录条目：Look 侧持久化行 + 归属/子会话元数据（被 session-catalog 与 session-index-store 共享，独立成文件以消除循环依赖）。 */
export interface StoredSession extends PersistedSessionRow {
	projectId: string;
	/** 持久化的子会话父标记（来自 look.subagent-parent.v1），生命周期跟随 JSONL 文件本身。 */
	parentSessionId?: string;
	/** 子会话的 agent 名称（同上，来自 JSONL），registry 清理后仍可恢复展示。 */
	subagentAgentName?: string;
}
