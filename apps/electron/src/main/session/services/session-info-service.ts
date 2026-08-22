// ============================================================
// SessionInfoService — AgentInfo projection builder
//
// Builds the renderer-facing AgentInfo objects from stored sessions,
// live runtimes, subagent metadata and IM bindings. Keeps the runtime
// façade from owning the projection logic.
// ============================================================

import { existsSync } from "node:fs";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SESSION_NAME } from "@look/shared/session-defaults";
import type { AgentInfo, ImSessionProvider, ProjectInfo, ThinkingLevel } from "@look/shared/types";
import { loadBindings } from "../../im/im-storage.js";
import type { ManagedRuntime, RuntimeRegistry } from "../runtime/runtime-registry.js";
import type { SessionScopeRegistry } from "../scope/scope-registry.js";
import type { SubAgentRegistry } from "../subagent-registry.js";
import type { ExpectedSessionDefaults } from "./expected-session-defaults.js";
import type { SessionCatalog, StoredSession } from "./session-catalog.js";
import type { SessionDraftIndex } from "./session-draft-index.js";

export interface SessionInfoServiceDependencies {
	runtimeRegistry: Pick<RuntimeRegistry, "get" | "entries">;
	sessionCatalog: Pick<SessionCatalog, "listByProject" | "get">;
	/** 未落盘草稿会话索引（列表合并与 getAgentInfo 兜底）。 */
	draftIndex: SessionDraftIndex;
	subAgentRegistry: Pick<SubAgentRegistry, "getMeta">;
	scopeRegistry: Pick<SessionScopeRegistry, "get">;
	maxNameLength: number;
	listProjects(): ProjectInfo[];
	/**
	 * 同步解析「预期会话默认值」（模型/思考级别，与 pi findInitialModel
	 * 同序）。草稿行的所有投影（创建、agent:list 合并、getAgentInfo 兜底）
	 * 都从这里取值——若只在创建时传一次，下一次 agent:list 会把模型冲回
	 * 空串，初始化完成前选择器来回跳变；projectId 用于读取项目级设置。
	 */
	getExpectedSessionDefaults(projectId: string): ExpectedSessionDefaults;
	/**
	 * 挂起意图投影覆盖：runtime 未就绪时用户已切换的模型/思考档位，
	 * 让草稿行/持久化行立即反映切换结果（物化后由 runtimeInfo 真值接管）。
	 */
	getPendingIntentOverrides?(sessionId: string): Partial<ExpectedSessionDefaults> | undefined;
}

export class SessionInfoService {
	private imBindingsCache: ReturnType<typeof loadBindings> | undefined;
	private imBindingsCacheTime = 0;
	/**
	 * Cache for non-live persisted sessions; key is derived from stable metadata.
	 * FIFO 上限：已删除会话的条目没有显式回收点，避免长会话期无限增长。
	 */
	private readonly persistedInfoCache = new Map<string, { key: string; info: AgentInfo }>();
	private static readonly PERSISTED_CACHE_MAX = 500;

	constructor(private readonly deps: SessionInfoServiceDependencies) {}

	private getImBindings(): ReturnType<typeof loadBindings> {
		const now = Date.now();
		if (!this.imBindingsCache || now - this.imBindingsCacheTime > 5_000) {
			this.imBindingsCache = loadBindings();
			this.imBindingsCacheTime = now;
		}
		return this.imBindingsCache;
	}

	getManagedRuntime(sessionId: string): ManagedRuntime | undefined {
		return this.deps.runtimeRegistry.get(sessionId);
	}

	/** 按 sessionId 查持久化会话（含 projectId），供 IPC 路由定位子会话目录。 */
	getStoredSession(sessionId: string): StoredSession | undefined {
		return this.deps.sessionCatalog.get(sessionId);
	}

	listAgents(): AgentInfo[] {
		return this.deps.listProjects().flatMap((project) => this.listAgentsInProject(project.id));
	}

	listAgentsInProject(projectId: string): AgentInfo[] {
		const persistedEntries = this.deps.sessionCatalog.listByProject(projectId);
		const persisted = persistedEntries.map((session) => {
			const managed = this.deps.runtimeRegistry.get(session.id);
			return managed ? this.runtimeInfo(session.id, managed) : this.sessionInfo(session);
		});
		const persistedIds = new Set(persistedEntries.map((session) => session.id));
		const runtimeBacked = Array.from(this.deps.runtimeRegistry.entries()).flatMap(([sessionId, managed]) =>
			managed.projectId === projectId && !persistedIds.has(sessionId) ? [this.runtimeInfo(sessionId, managed)] : [],
		);
		// 草稿索引行（未落盘会话）：创建即持久，重启后仍在；落盘后被 prune。
		// 初始化窗口期内同一会话会同时出现在 registry（runtime 已绑定）与索引
		// （pi 文件未落盘）——live 行优先，索引行必须对两者去重，否则渲染端
		// 收到同 id 两行 → React duplicate key。
		const knownIds = new Set([...persistedIds, ...runtimeBacked.map((agent) => agent.id)]);
		const indexDrafts = this.deps.draftIndex
			.list(projectId)
			.filter((entry) => !knownIds.has(entry.id))
			.map((entry) => this.draftInfo(entry.id, entry.projectId, entry.name, entry.imProvider));
		return [...indexDrafts, ...runtimeBacked, ...persisted];
	}

	getAgentInfo(sessionId: string): AgentInfo | undefined {
		const managed = this.deps.runtimeRegistry.get(sessionId);
		if (managed) return this.runtimeInfo(sessionId, managed);
		const session = this.deps.sessionCatalog.get(sessionId);
		if (session) return this.sessionInfo(session);
		// 草稿兜底：未落盘会话也能定位 projectId（trust 弹窗/激活路径）。
		const draft = this.deps.draftIndex.get(sessionId);
		return draft ? this.draftInfo(draft.id, draft.projectId, draft.name, draft.imProvider) : undefined;
	}

	/**
	 * 新建会话的乐观草稿投影：runtime 仍在后台初始化，主进程尚无
	 * runtime/stored 可查，但渲染端需要立即展示侧边栏行。
	 *
	 * 模型/思考字段来自 getExpectedSessionDefaults（与 pi findInitialModel
	 * 同序解析），草稿从第一帧就与正式行一致，避免初始化完成时模型/思考
	 * 选择器整行跳变；解析失败退回空占位。
	 */
	draftInfo(sessionId: string, projectId: string, name: string, imProvider?: ImSessionProvider): AgentInfo {
		// 挂起意图优先于预期默认值：初始化窗口内用户切换的模型/思考立即上屏。
		const resolved = {
			...this.deps.getExpectedSessionDefaults(projectId),
			...this.deps.getPendingIntentOverrides?.(sessionId),
		};
		const now = Date.now();
		return {
			id: sessionId,
			name: name.slice(0, this.deps.maxNameLength),
			imProvider,
			model: resolved?.model ?? "",
			thinkingLevel: resolved?.thinkingLevel ?? "off",
			modelSupportsThinking: resolved?.modelSupportsThinking ?? false,
			availableThinkingLevels: resolved?.availableThinkingLevels ?? ["off"],
			isStreaming: false,
			isRetrying: false,
			isCompacting: false,
			messageCount: 0,
			createdAt: now,
			lastActivityAt: now,
			sessionFilePath: undefined,
			projectId,
			contextUsage: undefined,
		};
	}

	private sessionInfo(session: StoredSession): AgentInfo {
		const managed = this.deps.runtimeRegistry.get(session.id);
		// Live runtimes can change between calls, so bypass the cache for them.
		if (managed) return this.runtimeInfo(session.id, managed);

		const cacheKey = `${session.path}:${session.modified.getTime()}:${session.messageCount}:${session.name}:${session.firstMessage}:${session.parentSessionId ?? ""}`;
		const cached = this.persistedInfoCache.get(session.id);
		const base = cached && cached.key === cacheKey ? cached.info : this.buildPersistedInfo(session, cacheKey);
		// 挂起意图覆盖在缓存读取之后应用（不进缓存：意图随物化消失）。
		const overrides = this.deps.getPendingIntentOverrides?.(session.id);
		return overrides ? { ...base, ...overrides } : base;
	}

	private buildPersistedInfo(session: StoredSession, cacheKey: string): AgentInfo {
		const info: AgentInfo = {
			id: session.id,
			name: (session.name || session.firstMessage || DEFAULT_SESSION_NAME).slice(0, this.deps.maxNameLength),
			imProvider: this.getImProvider(session.id),
			model: "",
			thinkingLevel: "off",
			modelSupportsThinking: false,
			availableThinkingLevels: ["off"],
			isStreaming: false,
			isRetrying: false,
			isCompacting: false,
			messageCount: session.messageCount,
			createdAt: session.created.getTime(),
			lastActivityAt: session.modified.getTime(),
			sessionFilePath: session.path,
			projectId: session.projectId,
			contextUsage: undefined,
			...this.subagentFields(session.id, session),
		};
		this.persistedInfoCache.set(session.id, { key: cacheKey, info });
		if (this.persistedInfoCache.size > SessionInfoService.PERSISTED_CACHE_MAX) {
			const oldest = this.persistedInfoCache.keys().next().value;
			if (oldest !== undefined) this.persistedInfoCache.delete(oldest);
		}
		return info;
	}

	private runtimeInfo(
		sessionId: string,
		managed: { runtime: AgentSessionRuntime; projectId: string; createdAt: number },
	): AgentInfo {
		const session = managed.runtime.session;
		const stats = session.getSessionStats();
		const model = session.model;
		// 对齐 Proma：lastActivityAt 只反映内容落盘时间（文件 mtime）。
		// 不用 isStreaming ? Date.now() —— 否则点击/激活会话推送 agent:updated
		// 时会把选中会话顶到列表顶部。打开查看不写文件 → mtime 不变 → 不跳位。
		const stored = this.deps.sessionCatalog.get(sessionId);
		const lastActivityAt = stored?.modified.getTime() ?? managed.createdAt;
		return {
			id: sessionId,
			name: (session.sessionManager.getSessionName() || DEFAULT_SESSION_NAME).slice(0, this.deps.maxNameLength),
			imProvider: this.getImProvider(sessionId),
			model: model ? `${model.provider}/${model.id}` : "",
			thinkingLevel: session.thinkingLevel as ThinkingLevel,
			modelSupportsThinking: session.supportsThinking(),
			availableThinkingLevels: session.getAvailableThinkingLevels() as ThinkingLevel[],
			isStreaming: session.isStreaming || session.isRetrying,
			isRetrying: session.isRetrying,
			isCompacting: session.isCompacting,
			messageCount: stats.totalMessages,
			createdAt: managed.createdAt,
			lastActivityAt,
			sessionFilePath: session.sessionFile && existsSync(session.sessionFile) ? session.sessionFile : undefined,
			projectId: managed.projectId,
			contextUsage: session.getContextUsage(),
			...this.subagentFields(sessionId, this.deps.sessionCatalog.get(sessionId)),
		};
	}

	private getImProvider(sessionId: string): ImSessionProvider | undefined {
		const scope = this.deps.scopeRegistry.get(sessionId);
		if (scope?.imProvider) return scope.imProvider as ImSessionProvider;
		const binding = this.getImBindings().find((item) => item.sessionId === sessionId);
		return binding ? "feishu" : undefined;
	}

	private subagentFields(
		sessionId: string,
		session: StoredSession | undefined,
	): Pick<AgentInfo, "parentSessionId" | "isSubagentSession" | "agentConfigName"> {
		// 运行中子会话以 registry 为准（执行态信息最新）；registry 清理后
		// 回退到 JSONL 持久化的父子标记，保证标记生命周期跟随文件本身。
		// 注意：registry 查询必须无条件执行，不能依赖 sessionCatalog 是否已收录该会话——
		// 子会话刚创建时 runSubSession 不会触发 catalog refresh，若以 session 是否存在
		// 作为前置条件，agent:created 的 AgentInfo 会丢失 parentSessionId，侧栏把运行中
		// 的子会话错误地显示为顶层父会话（完成后 agent_end 刷新 catalog 才“恢复”为子会话）。
		const meta = this.deps.subAgentRegistry.getMeta(sessionId);
		const parentSessionId = meta?.parentSessionId ?? session?.parentSessionId;
		if (!parentSessionId) return {};
		return {
			parentSessionId,
			isSubagentSession: true,
			agentConfigName: meta?.agentName ?? session?.subagentAgentName,
		};
	}
}
