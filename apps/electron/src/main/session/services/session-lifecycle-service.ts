// ============================================================
// SessionLifecycleService — create / destroy / abort sessions
//
// Owns high-level session lifecycle orchestration so that the runtime
// façade only wires dependencies and delegates.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ensureWorkspaceDir, getWorkspaceSessionsDir } from "@look/shared/look-storage";
import { DEFAULT_SESSION_NAME } from "@look/shared/session-defaults";
import type { AgentInfo, ImSessionProvider, MainToRendererEvent, SessionSnapshotEnvelope } from "@look/shared/types";
import type { IPermissionService, IPlanService } from "../../core/contracts.js";
import type { ProjectService } from "../../projects/project-service.js";
import type { SubAgentRuntimeService } from "../../services/subagent-runtime.js";
import type { UserSettingsStore } from "../../settings/store.js";
import { withDeadline } from "../../utils/with-deadline.js";
import { MAX_NAME_LENGTH, SESSION_INIT_TIMEOUT_MS } from "../constants.js";
import type { ManagedRuntime, RuntimeRegistry } from "../runtime/runtime-registry.js";
import type { SessionScopeRegistry } from "../scope/scope-registry.js";
import type { AttachmentService } from "./attachment-service.js";
import { selectSdkFallbackModel } from "./expected-session-defaults.js";
import type { StoredSession } from "./session-catalog.js";
import type { SessionDraftIndex } from "./session-draft-index.js";
import type { SessionInfoService } from "./session-info-service.js";

type AvailableModel = {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number };
};

export interface SessionLifecycleHost {
	createManagedRuntime(
		cwd: string,
		sessionManager: SessionManager,
		projectId: string,
		createdAt: number,
		sessionStartEvent?: import("@earendil-works/pi-coding-agent").SessionStartEvent,
		options?: { appendSystemPrompt?: string[] },
	): Promise<ManagedRuntime>;
	disposeRuntime(sessionId: string, abort?: boolean): Promise<void>;
	refreshProjectSessions(projectId: string): Promise<StoredSession[]>;
	getStoredSession(sessionId: string): StoredSession | undefined;
	/** Remove a session from the catalog index (before disposing its runtime). */
	removeStoredSession(sessionId: string): void;
	emit(event: MainToRendererEvent): void;
	emitSessionState(sessionId: string, reason?: SessionSnapshotEnvelope["reason"]): void;
	emitSessionList(projectId: string): void;
	setActiveProjectId(projectId: string): void;
	setActiveSessionId(sessionId: string | null): void;
	getActiveSessionId(): string | null;
}

export interface SessionLifecycleServiceDependencies {
	host: SessionLifecycleHost;
	projectService: ProjectService;
	/** 未落盘会话的草稿索引（创建即持久、重启可恢复）。 */
	draftIndex: SessionDraftIndex;
	runtimeRegistry: Pick<RuntimeRegistry, "get">;
	scopeRegistry: Pick<SessionScopeRegistry, "get">;
	subAgentRuntimeService: SubAgentRuntimeService;
	sessionInfoService: SessionInfoService;
	permissionService: IPermissionService;
	planService: IPlanService;
	userSettings: UserSettingsStore;
	modelRegistry: Pick<ModelRegistry, "find">;
	/** 粘贴附件服务：会话销毁时级联清理附件目录。 */
	attachments: AttachmentService;
	getAvailableModelsSync(): AvailableModel[];
}

export interface EnsureSessionModelDeps {
	getAvailableModelsSync(): AvailableModel[];
	modelRegistry: Pick<ModelRegistry, "find">;
	userSettings: Pick<UserSettingsStore, "getAll" | "update">;
}

/**
 * 确保会话有模型 —— 新建/历史恢复/子会话统一入口(由 runtime-lifecycle-coordinator
 * 的 bindRuntime 调用)。
 *
 * - 已解析出模型 → 跳过
 * - 未解析(SDK findInitialModel 在快照失真/无可用时静默返回 undefined) →
 *   按 pi 的 provider 默认模型表选择第一个命中的可用模型；无命中时取首个
 *   可用模型。setModel 内部用实时 checkAuth 校验凭据
 *   (agent-session.js),失败 throw → 忽略,保持现状(发送时会报明确错误)
 * - setModel 副作用:持久化 defaultProvider/defaultModel 到 settings.json
 *   (agent-session.js setDefaultModelAndProvider)。若用户已设置全局默认模型
 *   且与兜底模型不同,恢复原默认 —— 与 plan 模式切换的防污染机制一致。
 */
export async function ensureSessionModel(
	session: { model: unknown; setModel(model: unknown): Promise<unknown> },
	deps: EnsureSessionModelDeps,
): Promise<void> {
	if (session.model) return;
	const savedPreferred = deps.userSettings.getAll().preferredModel;
	try {
		const available = deps.getAvailableModelsSync();
		if (available.length === 0) return;
		const first = selectSdkFallbackModel(available);
		if (!first) return;
		const model = deps.modelRegistry.find(first.provider, first.id);
		if (!model) return;
		await session.setModel(model);
		// 防污染:兜底模型与用户全局默认不同时恢复原默认
		if (savedPreferred && savedPreferred !== `${model.provider}/${model.id}`) {
			await deps.userSettings.update({ preferredModel: savedPreferred });
		}
	} catch {
		// 兜底失败保持现状,不阻断
	}
}

export class SessionLifecycleService {
	/** 后台初始化中的新建会话（sessionId → 初始化 promise）。 */
	private readonly pendingCreations = new Map<string, Promise<void>>();

	constructor(private readonly deps: SessionLifecycleServiceDependencies) {}

	/** 等待所有后台创建 settle（测试/关闭前冲刷用）。 */
	async awaitPendingCreations(): Promise<void> {
		await Promise.allSettled([...this.pendingCreations.values()]);
	}

	/**
	 * 等待某个会话的后台创建完成（无 pending 时立即返回）。
	 * 供 headless/IM 等拿到 ID 后立即操作 runtime 的调用方阻塞到就绪；
	 * 创建失败时向上抛出原始错误。
	 */
	async awaitCreation(sessionId: string): Promise<void> {
		await this.pendingCreations.get(sessionId);
	}

	/**
	 * 新建会话：立即分配 session ID 并返回最终形态的草稿行，runtime 初始化
	 * 转后台（Proma 式「创建即终态」）。
	 *
	 * 此前整条链路（串行资源锁 + 扩展/包/agent 目录扫描 + bind）都在 IPC
	 * 返回前 await，慢速 MCP / 缺包 npm install / 排队中的其他初始化会让
	 * 「新建会话」点击后长时间无响应。现在 SessionManager.create（同步、
	 * 不落盘）+ 草稿索引落盘后马上发出与正式行一致的草稿行（模型/思考
	 * 同步解析）并返回；runtime 就绪后只补发 session:snapshot，不再补发
	 * agent:created——渲染端零跳变。初始化期间渲染端的发送/激活经
	 * ensureRuntime 等待 in-flight 创建（见 runtime-lifecycle-coordinator）。
	 */
	async createAgent(
		opts?: { name?: string; projectId?: string; imProvider?: ImSessionProvider; background?: boolean } | string,
	): Promise<AgentInfo> {
		const input = typeof opts === "string" ? { name: opts } : (opts ?? {});
		const projectId = input.projectId ?? this.deps.projectService.activeId;
		if (!projectId) throw new Error("No active project");
		const project = this.deps.projectService.getProjectInfo(projectId);
		if (!project?.valid) throw new Error(`Project path does not exist: ${project?.cwd ?? projectId}`);

		const sessionManager = SessionManager.create(project.cwd, ensureWorkspaceDir(projectId));
		const sessionId = sessionManager.getSessionId();
		const name = (input.name?.trim() || DEFAULT_SESSION_NAME).slice(0, MAX_NAME_LENGTH);
		// 草稿投影内部解析预期默认值（模型/思考与 pi findInitialModel 同序），
		// 第一帧即与正式行一致。
		const draft = this.deps.sessionInfoService.draftInfo(sessionId, projectId, name, input.imProvider);

		// 创建即落草稿索引（Proma 式最小双事实源）：pi JSONL 仍是内容真源，
		// 索引只保证未落盘会话在崩溃/重启后可恢复。会话文件一旦落盘，
		// refreshProjectSessions 会 prune 掉对应条目。
		const now = Date.now();
		this.deps.draftIndex.add({
			id: sessionId,
			projectId,
			name,
			imProvider: input.imProvider,
			createdAt: now,
			updatedAt: now,
		});

		if (!input.background) {
			this.deps.host.setActiveProjectId(projectId);
			this.deps.host.setActiveSessionId(sessionId);
		}
		// 草稿行先行：渲染端立即出现新会话（IPC 返回值与该事件同形，互为兜底）。
		this.deps.host.emit({ type: "agent:created", agentId: sessionId, agent: draft });

		const creation = this.initializeCreatedSession({
			cwd: project.cwd,
			sessionManager,
			sessionId,
			projectId,
			name,
			imProvider: input.imProvider,
		});
		this.pendingCreations.set(sessionId, creation);
		// 后台失败已在 initializeCreatedSession 内清理并上报，这里吞掉避免
		// unhandled rejection；awaitCreation 的调用方仍会拿到原始错误。
		void creation
			.catch(() => undefined)
			.finally(() => {
				if (this.pendingCreations.get(sessionId) === creation) this.pendingCreations.delete(sessionId);
			});
		return draft;
	}

	private async initializeCreatedSession(args: {
		cwd: string;
		sessionManager: SessionManager;
		sessionId: string;
		projectId: string;
		name: string;
		imProvider?: ImSessionProvider;
	}): Promise<void> {
		const { cwd, sessionManager, sessionId, projectId, name, imProvider } = args;
		try {
			const managed = await withDeadline(
				this.deps.host.createManagedRuntime(cwd, sessionManager, projectId, Date.now()),
				SESSION_INIT_TIMEOUT_MS,
				`Session ${sessionId} initialization timed out after ${SESSION_INIT_TIMEOUT_MS / 1000}s`,
			);
			const session = managed.runtime.session;
			session.setSessionName(name);

			const scope = this.deps.scopeRegistry.get(sessionId);
			if (scope) scope.isDefaultName = true;
			if (imProvider) {
				const scope = this.deps.scopeRegistry.get(sessionId);
				if (scope) scope.imProvider = imProvider;
			}

			// 创建期间用户可能已删除该会话：runtime 已被 dispose、registry 条目
			// 不复存在，此时再补发事件会在渲染端复活已删除的会话行。
			if (this.deps.runtimeRegistry.get(sessionId) !== managed) {
				return;
			}

			// Proma 式单事件收敛：会话行在创建时已以最终形态发出（模型/思考
			// 同步解析），初始化完成不再补发 agent:created——渲染端的行、快照
			// 投影与后续 agent:list 全部命中幂等守卫，视觉上零变化。
			await this.deps.host.refreshProjectSessions(projectId);
			this.deps.host.emitSessionState(sessionId, "initial");
		} catch (error) {
			// 用户在草稿期主动删除：删除路径已移除草稿索引条目，这里只做清理，
			// 不再弹错误 toast / 发 destroyed（否则用户删一个刚建的会话反而
			// 看到「初始化失败：was disposed while initializing」）。
			const userDeleted = this.deps.draftIndex.get(sessionId) === undefined;
			console.error(`[Look] Background session initialization failed for ${sessionId}:`, error);
			this.deps.draftIndex.remove(sessionId);
			if (this.deps.host.getActiveSessionId() === sessionId) {
				this.deps.host.setActiveSessionId(null);
			}
			if (userDeleted) {
				// 交给 awaitCreation 的调用方（headless/IM）；fire-and-forget 链路已吞掉。
				throw error;
			}
			// 先给用户可见反馈，再做后台清理：清理需要等待 in-flight 初始化
			// settle（disposeRuntime 内部 awaitInitialization），挂死的初始化
			// 会让清理同样挂起——不能让错误 toast 被它挡住。
			const message = error instanceof Error ? error.message : String(error);
			this.deps.host.emit({
				type: "error",
				agentId: sessionId,
				message: `Failed to initialize session: ${message}`,
			});
			this.deps.host.emit({ type: "agent:destroyed", agentId: sessionId });
			// 兜底清理：createManagedRuntime 失败路径内部已清理自身；这里补扫
			// 半绑定残留（dispose 可能再落盘 JSONL，随后按规范路径清掉文件，
			// 避免 refreshProjectSessions 扫出幽灵会话行）。
			void this.deps.host
				.disposeRuntime(sessionId, true)
				.catch(() => undefined)
				.finally(() => {
					// 保持 dispose → 删文件 → 重扫目录的顺序，避免重扫扫出幽灵行。
					this.removeSessionFile(projectId, sessionId);
					void this.deps.host.refreshProjectSessions(projectId).catch(() => undefined);
				});
			// 交给 awaitCreation 的调用方（headless/IM）；fire-and-forget 链路已吞掉。
			throw error;
		}
	}

	async destroyAgent(sessionId: string): Promise<void> {
		await this.deps.subAgentRuntimeService.destroySubSessions(sessionId);
		const stored = this.deps.host.getStoredSession(sessionId);
		const managed = this.deps.runtimeRegistry.get(sessionId);
		// 草稿期会话（runtime 初始化中或已落索引）：projectId 从草稿索引取，
		// 删除即移除索引条目——初始化 settle 后的 catch 以此判断「用户已删」
		// 而不再弹错（见 initializeCreatedSession）。
		const draftEntry = this.deps.draftIndex.get(sessionId);
		this.deps.draftIndex.remove(sessionId);
		const projectId = stored?.projectId ?? managed?.projectId ?? draftEntry?.projectId;
		if (!projectId) return;
		// 级联清理该会话的粘贴附件目录（附件是会话级数据，随会话销毁）。
		this.deps.attachments.deleteSessionAttachments(projectId, sessionId);
		// 先从目录索引移除 stored：disposeRuntime 进行中/完成后，任何并发
		// ensureRuntime（如排队中的 applyMode 权限切换）都会因 getStoredSession
		// 为空而失败，不会为"正在删除"的会话重建幽灵 runtime。随后的
		// refreshProjectSessions 基于磁盘（文件已删）重建索引，结果一致。
		if (stored) this.deps.host.removeStoredSession(sessionId);
		const dispose = this.deps.host.disposeRuntime(sessionId, true);
		if (draftEntry && !managed) {
			// 仅当 runtime 尚未注册（初始化仍 in-flight）时才转入后台：
			// disposeRuntime 内部等待初始化 settle，挂死时会永久吊住，destroyed
			// 事件发不出去。此时列表里还没有 runtime 行，立即发列表不会复活。
			// 待 dispose settle 后自行完成 JSONL 兜底删除与目录重扫。
			void dispose
				.catch(() => undefined)
				.finally(() => {
					if (!stored) this.removeSessionFile(projectId, sessionId);
					void this.deps.host.refreshProjectSessions(projectId).catch(() => undefined);
				});
		} else {
			// runtime 已注册：dispose 会快速 settle，必须 await——否则紧跟其后的
			// emitSessionList 会带着 registry 中尚未移除的 runtime 行重建列表，
			// 把刚删除的会话行复活（直到下次列表刷新才消失）。
			await dispose;
			if (stored) {
				try {
					fs.unlinkSync(stored.path);
				} catch (error) {
					if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
				}
			} else {
				// 兜底：stored 缺失（异常中间态）时按规范路径清理，避免
				// refreshProjectSessions 扫出幽灵行。
				this.removeSessionFile(projectId, sessionId);
			}
			await this.deps.host.refreshProjectSessions(projectId);
		}
		if (this.deps.host.getActiveSessionId() === sessionId) {
			this.deps.host.setActiveSessionId(null);
		}
		this.deps.host.emit({ type: "agent:destroyed", agentId: sessionId });
		this.deps.host.emitSessionList(projectId);
	}

	/** 按规范路径清理会话 JSONL（stored 缺失时的草稿期兜底）。 */
	private removeSessionFile(projectId: string, sessionId: string): void {
		const sessionFile = path.join(getWorkspaceSessionsDir(projectId), `${sessionId}.jsonl`);
		try {
			fs.unlinkSync(sessionFile);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				console.warn(`[Look] Failed to remove session file ${sessionFile}:`, error);
			}
		}
	}

	async abortAgent(sessionId: string): Promise<void> {
		const managed = this.deps.runtimeRegistry.get(sessionId);
		if (!managed) return;
		await this.deps.subAgentRuntimeService.abortSubSessions(sessionId);
		this.deps.permissionService.cancelPending(sessionId);
		this.deps.planService.cancelInteractions(sessionId, "Stopped by user");
		await managed.runtime.session.abort();
	}
}
