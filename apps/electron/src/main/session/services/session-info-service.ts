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
import type { SessionCatalog, StoredSession } from "./session-catalog.js";

export interface SessionInfoServiceDependencies {
	runtimeRegistry: Pick<RuntimeRegistry, "get" | "entries">;
	sessionCatalog: Pick<SessionCatalog, "listByProject" | "get">;
	subAgentRegistry: Pick<SubAgentRegistry, "getMeta">;
	scopeRegistry: Pick<SessionScopeRegistry, "get">;
	maxNameLength: number;
	listProjects(): ProjectInfo[];
}

export class SessionInfoService {
	private imBindingsCache: ReturnType<typeof loadBindings> | undefined;
	private imBindingsCacheTime = 0;
	/** Cache for non-live persisted sessions; key is derived from stable metadata. */
	private readonly persistedInfoCache = new Map<string, { key: string; info: AgentInfo }>();

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
		const drafts = Array.from(this.deps.runtimeRegistry.entries()).flatMap(([sessionId, managed]) =>
			managed.projectId === projectId && !persistedIds.has(sessionId) ? [this.runtimeInfo(sessionId, managed)] : [],
		);
		return [...drafts, ...persisted];
	}

	getAgentInfo(sessionId: string): AgentInfo | undefined {
		const managed = this.deps.runtimeRegistry.get(sessionId);
		if (managed) return this.runtimeInfo(sessionId, managed);
		const session = this.deps.sessionCatalog.get(sessionId);
		return session ? this.sessionInfo(session) : undefined;
	}

	private sessionInfo(session: StoredSession): AgentInfo {
		const managed = this.deps.runtimeRegistry.get(session.id);
		// Live runtimes can change between calls, so bypass the cache for them.
		if (managed) return this.runtimeInfo(session.id, managed);

		const cacheKey = `${session.path}:${session.modified.getTime()}:${session.messageCount}:${session.name}:${session.firstMessage}`;
		const cached = this.persistedInfoCache.get(session.id);
		if (cached && cached.key === cacheKey) return cached.info;

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
			sessionFilePath: session.path,
			projectId: session.projectId,
			contextUsage: undefined,
			...this.subagentFields(session.id),
		};
		this.persistedInfoCache.set(session.id, { key: cacheKey, info });
		return info;
	}

	private runtimeInfo(
		sessionId: string,
		managed: { runtime: AgentSessionRuntime; projectId: string; createdAt: number },
	): AgentInfo {
		const session = managed.runtime.session;
		const stats = session.getSessionStats();
		const model = session.model;
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
			sessionFilePath: session.sessionFile && existsSync(session.sessionFile) ? session.sessionFile : undefined,
			projectId: managed.projectId,
			contextUsage: session.getContextUsage(),
			...this.subagentFields(sessionId),
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
	): Pick<AgentInfo, "parentSessionId" | "isSubagentSession" | "agentConfigName"> {
		const meta = this.deps.subAgentRegistry.getMeta(sessionId);
		if (!meta) return {};
		return {
			parentSessionId: meta.parentSessionId,
			isSubagentSession: true,
			agentConfigName: meta.agentName,
		};
	}
}
