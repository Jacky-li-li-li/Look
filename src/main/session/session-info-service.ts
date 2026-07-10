// ============================================================
// SessionInfoService — AgentInfo projection builder
//
// Builds the renderer-facing AgentInfo objects from stored sessions,
// live runtimes, subagent metadata and IM bindings. Keeps the runtime
// façade from owning the projection logic.
// ============================================================

import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { DEFAULT_SESSION_NAME } from "@look/shared/session-defaults";
import type { AgentInfo, ImSessionProvider, ProjectInfo, ThinkingLevel } from "@look/shared/types";
import { loadBindings } from "../im/im-storage.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import type { SessionScopeRegistry } from "./scope-registry.js";
import type { SessionCatalog, StoredSession } from "./session-catalog.js";
import type { SubAgentRegistry } from "./subagent-registry.js";

export interface SessionInfoServiceDependencies {
	runtimeRegistry: Pick<RuntimeRegistry, "get" | "entries">;
	sessionCatalog: Pick<SessionCatalog, "listByProject" | "get">;
	subAgentRegistry: Pick<SubAgentRegistry, "getMeta">;
	scopeRegistry: Pick<SessionScopeRegistry, "get">;
	maxNameLength: number;
	isStreaming(sessionId: string, sdkValue: boolean): boolean;
	listProjects(): ProjectInfo[];
}

export class SessionInfoService {
	private imBindingsCache: ReturnType<typeof loadBindings> | undefined;
	private imBindingsCacheTime = 0;

	constructor(private readonly deps: SessionInfoServiceDependencies) {}

	private getImBindings(): ReturnType<typeof loadBindings> {
		const now = Date.now();
		if (!this.imBindingsCache || now - this.imBindingsCacheTime > 5_000) {
			this.imBindingsCache = loadBindings();
			this.imBindingsCacheTime = now;
		}
		return this.imBindingsCache;
	}

	getManagedRuntime(
		sessionId: string,
	): { runtime: AgentSessionRuntime; projectId: string; createdAt: number; unsubscribe: () => void } | undefined {
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
		const piSession = managed?.runtime.session;
		const stats = piSession?.getSessionStats();
		const model = piSession?.model;
		return {
			id: session.id,
			name: (session.name || session.firstMessage || DEFAULT_SESSION_NAME).slice(0, this.deps.maxNameLength),
			imProvider: this.getImProvider(session.id),
			model: model ? `${model.provider}/${model.id}` : "",
			thinkingLevel: (piSession?.thinkingLevel as ThinkingLevel | undefined) ?? "off",
			modelSupportsThinking: piSession?.supportsThinking() ?? false,
			availableThinkingLevels: (piSession?.getAvailableThinkingLevels() as ThinkingLevel[] | undefined) ?? ["off"],
			isStreaming: piSession?.isStreaming ?? false,
			isRetrying: piSession?.isRetrying ?? false,
			isCompacting: piSession?.isCompacting ?? false,
			messageCount: stats?.totalMessages ?? session.messageCount,
			createdAt: session.created.getTime(),
			sessionFilePath: session.path,
			projectId: session.projectId,
			contextUsage: piSession?.getContextUsage(),
			...this.subagentFields(session.id),
		};
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
			isStreaming: this.deps.isStreaming(sessionId, session.isStreaming),
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
