// ============================================================
// SessionControlService — model, thinking, compaction and naming commands
//
// This service owns commands that change one session's SDK configuration. It
// receives only a narrow lifecycle/query port, never the full façade.
// ============================================================

import type { ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionSnapshotEnvelope, ThinkingLevel } from "@look/shared/types";
import type { ISessionScopeRegistry } from "../../core/contracts.js";
import { MAX_NAME_LENGTH } from "../constants.js";
import type { ManagedRuntime } from "../runtime/runtime-registry.js";

export interface SessionControlHost {
	ensureRuntime(sessionId: string): Promise<ManagedRuntime>;
	getManagedRuntime(sessionId: string): ManagedRuntime | undefined;
	getSessionManager(sessionId: string): SessionManager | undefined;
	/** 会话存在性（live runtime 之外）：catalog stored / 草稿索引 / 在途初始化。 */
	sessionExists(sessionId: string): boolean;
	/** 挂起意图：runtime 未就绪时的模型/思考切换暂存，物化时应用。 */
	setPendingModel(sessionId: string, modelKey: string): void;
	setPendingThinkingLevel(sessionId: string, level: ThinkingLevel): void;
	updateStoredName(sessionId: string, name: string): { projectId: string } | undefined;
	closeDefaultNameGate(sessionId: string): void;
	emitSessionUpdated(sessionId: string): void;
	emitSessionList(projectId: string): void;
	emitSessionState(sessionId: string, reason?: SessionSnapshotEnvelope["reason"]): void;
}

export class SessionControlService {
	constructor(
		private readonly host: SessionControlHost,
		private readonly modelRegistry: Pick<ModelRegistry, "find">,
		private readonly scopeRegistry: Pick<ISessionScopeRegistry, "get">,
		private readonly maxNameLength = MAX_NAME_LENGTH,
	) {}

	async setModel(sessionId: string, modelKey: string): Promise<void> {
		const slash = modelKey.indexOf("/");
		if (slash <= 0) throw new Error(`Model key must be in provider/model form: ${modelKey}`);
		const model = this.modelRegistry.find(modelKey.slice(0, slash), modelKey.slice(slash + 1));
		if (!model) throw new Error(`Model not found: ${modelKey}`);
		const managed = this.host.getManagedRuntime(sessionId);
		if (managed) {
			// runtime 就绪：直接切换（checkAuth 无网络、JSONL/设置写入均同步）。
			await managed.runtime.session.setModel(model);
			this.host.emitSessionUpdated(sessionId);
			return;
		}
		// runtime 未就绪（后台初始化中/尚未激活）：记录挂起意图立即返回，
		// 物化时经 createAgentSessionFromServices 的 model 选项应用——
		// 不等 ensureRuntime，切换模型不再被会话初始化阻塞。
		if (!this.host.sessionExists(sessionId)) throw new Error(`Session ${sessionId} not found`);
		this.host.setPendingModel(sessionId, modelKey);
		this.host.emitSessionUpdated(sessionId);
	}

	async setThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<void> {
		const managed = this.host.getManagedRuntime(sessionId);
		if (managed) {
			managed.runtime.session.setThinkingLevel(level);
			return;
		}
		// 与 setModel 同理：挂起意图，物化时应用，不为切思考档位拉起 runtime。
		if (!this.host.sessionExists(sessionId)) throw new Error(`Session ${sessionId} not found`);
		this.host.setPendingThinkingLevel(sessionId, level);
		this.host.emitSessionUpdated(sessionId);
	}

	async compress(sessionId: string, customInstructions?: string): Promise<void> {
		const session = (await this.host.ensureRuntime(sessionId)).runtime.session;
		if (!session.isStreaming && !session.isRetrying && !session.isCompacting) {
			const result = await session.compact(customInstructions);
			// SDK workaround: CompactionResult.estimatedTokensAfter is returned by session.compact()
			// but not persisted on the session object. We store it in SessionScope so emitSessionState
			// can include it in the snapshot sent to the renderer.
			// @see ARCHITECTURE: pi SDK workaround #3
			if (result?.estimatedTokensAfter != null) {
				const scope = this.scopeRegistry.get(sessionId);
				if (scope) scope.compactionEstimatedTokensAfter = result.estimatedTokensAfter;
			}
			// Emit a fresh snapshot so sessionState.runtime.compactionEstimatedTokensAfter
			// reaches the renderer for display in CompactionStatusCard.
			this.host.emitSessionState(sessionId);
		}
	}

	abortCompress(sessionId: string): void {
		const managed = this.host.getManagedRuntime(sessionId);
		managed?.runtime.session.abortCompaction();
	}

	rename(sessionId: string, name: string): void {
		const trimmed = name.trim().slice(0, this.maxNameLength);
		if (!trimmed) return;
		const managed = this.host.getManagedRuntime(sessionId);
		if (managed) managed.runtime.session.setSessionName(trimmed);
		else this.host.getSessionManager(sessionId)?.appendSessionInfo(trimmed);
		this.host.closeDefaultNameGate(sessionId);
		const stored = this.host.updateStoredName(sessionId, trimmed);
		this.host.emitSessionUpdated(sessionId);
		if (stored) this.host.emitSessionList(stored.projectId);
	}
}
