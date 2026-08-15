// ============================================================
// SessionPendingIntents — 会话级挂起意图（模型/思考）
//
// 「意图先行，物化追赶」：runtime 未就绪（后台初始化中/尚未激活）时，
// 用户的模型/思考切换不等待 ensureRuntime，而是记录在这里并立即返回；
// RuntimeLifecycleCoordinator.createManagedRuntime 在物化时取出并经
// createAgentSessionFromServices 的 model/thinkingLevel 选项应用——
// SDK 会自行把 model_change 写入 pi JSONL，真源不变。
//
// 只存内存：进程退出后草稿会话恢复走 SDK 默认模型解析，与既有行为一致。
// ============================================================

import type { ThinkingLevel } from "@look/shared/types";

export class SessionPendingIntents {
	private readonly models = new Map<string, string>();
	private readonly thinkingLevels = new Map<string, ThinkingLevel>();

	setModel(sessionId: string, modelKey: string): void {
		this.models.set(sessionId, modelKey);
	}

	peekModel(sessionId: string): string | undefined {
		return this.models.get(sessionId);
	}

	/** 物化时消费：取出即清除，避免重复应用。 */
	takeModel(sessionId: string): string | undefined {
		const modelKey = this.models.get(sessionId);
		if (modelKey !== undefined) this.models.delete(sessionId);
		return modelKey;
	}

	setThinkingLevel(sessionId: string, level: ThinkingLevel): void {
		this.thinkingLevels.set(sessionId, level);
	}

	peekThinkingLevel(sessionId: string): ThinkingLevel | undefined {
		return this.thinkingLevels.get(sessionId);
	}

	takeThinkingLevel(sessionId: string): ThinkingLevel | undefined {
		const level = this.thinkingLevels.get(sessionId);
		if (level !== undefined) this.thinkingLevels.delete(sessionId);
		return level;
	}

	clear(sessionId: string): void {
		this.models.delete(sessionId);
		this.thinkingLevels.delete(sessionId);
	}
}
