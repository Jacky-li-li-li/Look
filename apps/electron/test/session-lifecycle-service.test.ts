import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ManagedRuntime } from "../src/main/session/runtime/runtime-registry.js";
import type { StoredSession } from "../src/main/session/services/session-catalog.js";
import { SessionDraftIndex } from "../src/main/session/services/session-draft-index.js";
import type { SessionLifecycleHost } from "../src/main/session/services/session-lifecycle-service.js";
import { ensureSessionModel, SessionLifecycleService } from "../src/main/session/services/session-lifecycle-service.js";

describe("SessionLifecycleService", () => {
	function makeSession(id = "session-1", model?: unknown) {
		return {
			sessionId: id,
			model,
			setSessionName: vi.fn(),
			setModel: vi.fn().mockResolvedValue(undefined),
			abort: vi.fn().mockResolvedValue(undefined),
		};
	}

	function makeManagedRuntime(
		sessionId: string,
		projectId = "project-1",
		cwd = "/project",
		model?: unknown,
	): ManagedRuntime {
		return {
			runtime: { session: makeSession(sessionId, model), cwd } as unknown as AgentSessionRuntime,
			projectId,
			cwd,
			createdAt: Date.now(),
			unsubscribe: vi.fn(),
		};
	}

	function makeService(overrides?: {
		activeProjectId?: string | null;
		runtime?: ManagedRuntime | null;
		stored?: StoredSession | null;
		availableModels?: Array<{ provider: string; id: string }>;
		preferredModel?: string | null;
		findResult?: unknown;
		hasAuth?: boolean;
	}) {
		const projectId = overrides?.activeProjectId ?? "project-1";
		// 注意：不能用 ?? ——显式传入 runtime: null 表示「无 runtime」，
		// ?? 会把 null 也兜底成 mock runtime，导致草稿期分支判定失真。
		const runtime = overrides?.runtime === undefined ? makeManagedRuntime("session-1") : overrides.runtime;
		// 每个 fixture 一份独立草稿索引文件，避免测试间状态串扰。
		const draftIndex = new SessionDraftIndex(
			join(mkdtempSync(join(tmpdir(), "look-drafts-")), "session-drafts.json"),
		);
		const host: SessionLifecycleHost = {
			createManagedRuntime: vi.fn().mockResolvedValue(runtime),
			disposeRuntime: vi.fn().mockResolvedValue(undefined),
			refreshProjectSessions: vi.fn().mockResolvedValue([]),
			getStoredSession: vi.fn().mockReturnValue(overrides?.stored ?? null),
			removeStoredSession: vi.fn(),
			emit: vi.fn(),
			emitSessionState: vi.fn(),
			emitSessionList: vi.fn(),
			setActiveProjectId: vi.fn(),
			setActiveSessionId: vi.fn(),
			getActiveSessionId: vi.fn().mockReturnValue(null),
		};
		return {
			service: new SessionLifecycleService({
				host,
				projectService: {
					activeId: projectId,
					getProjectInfo: (id) =>
						id === projectId
							? { id: projectId, name: "Project", cwd: "/project", valid: true, createdAt: Date.now() }
							: null,
				} as unknown as import("../src/main/projects/project-service.js").ProjectService,
				draftIndex,
				runtimeRegistry: {
					get: vi.fn().mockReturnValue(runtime),
				} as unknown as import("../src/main/session/runtime/runtime-registry.js").RuntimeRegistry,
				scopeRegistry: {
					get: vi.fn().mockReturnValue({ isDefaultName: false, imProvider: undefined }),
				} as unknown as import("../src/main/session/scope/scope-registry.js").SessionScopeRegistry,
				subAgentRuntimeService: {
					destroySubSessions: vi.fn().mockResolvedValue(undefined),
					abortSubSessions: vi.fn().mockResolvedValue(undefined),
				} as unknown as import("../src/main/services/subagent-runtime.js").SubAgentRuntimeService,
				sessionInfoService: {
					getAgentInfo: vi.fn().mockReturnValue({ id: "session-1", projectId }),
					// 与真实 draftInfo 同构：id 由调用方传入（SessionManager 分配）。
					draftInfo: vi.fn((id: string, pid: string, name: string, imProvider?: "feishu") => ({
						id,
						name,
						projectId: pid,
						imProvider,
						initializing: true,
					})),
				} as unknown as import("../src/main/session/services/session-info-service.js").SessionInfoService,
				permissionService: {
					cancelPending: vi.fn(),
				} as unknown as import("../src/main/core/contracts.js").IPermissionService,
				planService: {
					cancelInteractions: vi.fn(),
				} as unknown as import("../src/main/core/contracts.js").IPlanService,
				userSettings: {
					getAll: vi.fn().mockReturnValue({ preferredModel: overrides?.preferredModel ?? null }),
				} as unknown as import("../src/main/settings/store.js").UserSettingsStore,
				modelRegistry: {
					find: vi.fn().mockReturnValue(overrides?.findResult ?? null),
					hasConfiguredAuth: vi.fn().mockReturnValue(overrides?.hasAuth ?? true),
				} as unknown as import("@earendil-works/pi-coding-agent").ModelRegistry,
				getAvailableModelsSync: vi.fn().mockReturnValue(overrides?.availableModels ?? []),
			}),
			host,
			runtime,
			draftIndex,
		};
	}

	it("createAgent 先返回 initializing 草稿，后台初始化完成后再补发事件", async () => {
		const { service, host, runtime, draftIndex } = makeService();

		const draft = await service.createAgent("My Agent");

		// 草稿立即返回：真实 SessionManager 分配的 ID，带 initializing 标记
		expect(draft.initializing).toBe(true);
		expect(draft.name).toBe("My Agent");
		const sessionId = draft.id;
		// 创建即落草稿索引（崩溃/重启可恢复；落盘后由 refresh 修剪）
		expect(draftIndex.get(sessionId)).toMatchObject({ id: sessionId, projectId: "project-1", name: "My Agent" });
		// 先行草稿事件 + selection 已设置（无需等 runtime）
		expect(host.emit).toHaveBeenCalledWith({
			type: "agent:created",
			agentId: sessionId,
			agent: expect.objectContaining({ id: sessionId, initializing: true }),
		});
		expect(host.setActiveProjectId).toHaveBeenCalledWith("project-1");
		expect(host.setActiveSessionId).toHaveBeenCalledWith(sessionId);

		await service.awaitPendingCreations();

		// 后台完成：命名、默认名标记、目录刷新、真实 created + 初始快照
		expect(host.createManagedRuntime).toHaveBeenCalled();
		expect(runtime.runtime.session.setSessionName).toHaveBeenCalledWith("My Agent");
		expect(host.refreshProjectSessions).toHaveBeenCalledWith("project-1");
		expect(host.emit).toHaveBeenCalledWith({
			type: "agent:created",
			agentId: sessionId,
			agent: { id: "session-1", projectId: "project-1" },
		});
		expect(host.emitSessionState).toHaveBeenCalledWith(sessionId, "initial");
	});

	it("createAgent 在 runtime 创建完成前就返回（不等 createManagedRuntime）", async () => {
		const { service, host, runtime } = makeService();
		let releaseCreation: (() => void) | undefined;
		host.createManagedRuntime = vi.fn().mockImplementation(
			() =>
				new Promise<ManagedRuntime>((resolve) => {
					releaseCreation = () => resolve(runtime);
				}),
		);

		const draft = await service.createAgent();

		// IPC 已返回（草稿在手），但 runtime 初始化仍挂起
		expect(draft.id).toBeTruthy();
		expect(host.emitSessionState).not.toHaveBeenCalled();
		releaseCreation?.();
		await service.awaitPendingCreations();
		expect(host.emitSessionState).toHaveBeenCalledWith(draft.id, "initial");
	});

	it("后台初始化失败：清理 runtime、撤回草稿行并清空 selection", async () => {
		const { service, host } = makeService();
		let rejectCreation: (() => void) | undefined;
		host.createManagedRuntime = vi.fn().mockImplementation(
			() =>
				new Promise<ManagedRuntime>((_resolve, reject) => {
					rejectCreation = () => reject(new Error("boom"));
				}),
		);

		const draft = await service.createAgent();
		// 在初始化挂起期间把该会话设为 active，再放行失败
		vi.mocked(host.getActiveSessionId).mockReturnValue(draft.id);
		rejectCreation?.();
		await service.awaitPendingCreations();

		expect(host.disposeRuntime).toHaveBeenCalledWith(draft.id, true);
		expect(host.setActiveSessionId).toHaveBeenCalledWith(null);
		expect(host.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "error", agentId: draft.id }));
		expect(host.emit).toHaveBeenCalledWith({ type: "agent:destroyed", agentId: draft.id });
	});

	it("草稿期用户主动删除：初始化 settle 后不再弹错、不发多余的 destroyed", async () => {
		const { service, host } = makeService({ runtime: null, stored: null });
		let rejectCreation: (() => void) | undefined;
		host.createManagedRuntime = vi.fn().mockImplementation(
			() =>
				new Promise<ManagedRuntime>((_resolve, reject) => {
					rejectCreation = () => reject(new Error("was disposed while its runtime was initializing"));
				}),
		);
		vi.mocked(host.getStoredSession).mockReturnValue(null);

		const draft = await service.createAgent();
		// 初始化挂起期间用户删除草稿，随后初始化失败 settle
		const destroy = service.destroyAgent(draft.id);
		rejectCreation?.();
		await destroy;
		await service.awaitPendingCreations();

		// 删除路径自己的 destroyed 保留；初始化 catch 不得再弹 error / destroyed
		const emitted = vi.mocked(host.emit).mock.calls.map((call) => call[0]);
		expect(emitted.filter((event) => event.type === "error")).toHaveLength(0);
		expect(emitted.filter((event) => event.type === "agent:destroyed")).toHaveLength(1);
	});

	it("删除已初始化的草稿：等待 dispose 完成后再发列表，不复活会话行", async () => {
		const { service, host, draftIndex } = makeService();
		// runtime 已注册（默认 fixture），草稿索引仍在册（pi 文件未落盘）。
		draftIndex.add({
			id: "session-1",
			projectId: "project-1",
			name: "draft",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		let disposeResolve!: () => void;
		host.disposeRuntime = vi.fn().mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					disposeResolve = resolve;
				}),
		);
		const order: string[] = [];
		vi.mocked(host.emitSessionList).mockImplementation(() => order.push("list"));
		vi.mocked(host.emit).mockImplementation((event) => {
			if (event.type === "agent:destroyed") order.push("destroyed");
		});

		const destroy = service.destroyAgent("session-1");
		await new Promise((resolve) => setTimeout(resolve, 10));
		// dispose 完成前不得发列表：registry 中还有该 runtime，列表会把它带回来。
		expect(order).toEqual([]);
		disposeResolve();
		await destroy;
		expect(order).toEqual(["destroyed", "list"]);
	});

	it("草稿期删除挂死的初始化：destroyAgent 立即返回并撤下行（不等待 init settle）", async () => {
		const { service, host } = makeService({ runtime: null, stored: null });
		vi.mocked(host.getStoredSession).mockReturnValue(null);
		// 初始化与 dispose 都永远不 settle（模拟挂死的原生调用）
		host.createManagedRuntime = vi.fn().mockImplementation(() => new Promise<never>(() => {}));
		host.disposeRuntime = vi.fn().mockImplementation(() => new Promise<never>(() => {}));

		const draft = await service.createAgent();
		await service.destroyAgent(draft.id);

		const emitted = vi.mocked(host.emit).mock.calls.map((call) => call[0]);
		expect(emitted.some((event) => event.type === "agent:destroyed" && event.agentId === draft.id)).toBe(true);
		expect(host.disposeRuntime).toHaveBeenCalledWith(draft.id, true);
	});

	it("初始化挂死超过时限：明确失败撤下草稿，而不是永久「准备中」", async () => {
		vi.useFakeTimers();
		try {
			const { service, host } = makeService({ runtime: null, stored: null });
			vi.mocked(host.getStoredSession).mockReturnValue(null);
			// 初始化永远不 settle（模拟 pi 内部 await 挂死）
			host.createManagedRuntime = vi.fn().mockImplementation(() => new Promise<never>(() => {}));

			const draft = await service.createAgent();
			const pending = service.awaitPendingCreations();
			await vi.advanceTimersByTimeAsync(120_000);
			await pending;

			const emitted = vi.mocked(host.emit).mock.calls.map((call) => call[0]);
			expect(emitted.some((event) => event.type === "error" && /timed out/.test(event.message))).toBe(true);
			expect(emitted.some((event) => event.type === "agent:destroyed" && event.agentId === draft.id)).toBe(true);
			// 错误反馈不被后台清理阻塞：清理虽未完成，事件已先行发出
			expect(host.disposeRuntime).toHaveBeenCalledWith(draft.id, true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("awaitCreation 在后台初始化失败时向上抛出原始错误（headless 语义）", async () => {
		const { service, host } = makeService();
		let rejectCreation: (() => void) | undefined;
		host.createManagedRuntime = vi.fn().mockImplementation(
			() =>
				new Promise<ManagedRuntime>((_resolve, reject) => {
					rejectCreation = () => reject(new Error("install failed"));
				}),
		);

		const draft = await service.createAgent();
		const awaited = service.awaitCreation(draft.id);
		rejectCreation?.();

		await expect(awaited).rejects.toThrow("install failed");
	});

	it("destroyAgent 在草稿期（runtime 初始化中）也能定位项目并 dispose", async () => {
		const { service, host, draftIndex } = makeService({ runtime: null, stored: null });
		vi.mocked(host.getStoredSession).mockReturnValue(null);
		// 无 stored、无 runtime，仅草稿索引在册（草稿期删除）；索引即 projectId 来源。
		draftIndex.add({
			id: "session-1",
			projectId: "project-1",
			name: "draft",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		(host as unknown as { getActiveSessionId: () => string }).getActiveSessionId = vi
			.fn()
			.mockReturnValue("session-1");

		await service.destroyAgent("session-1");

		expect(draftIndex.get("session-1")).toBeUndefined();

		expect(host.disposeRuntime).toHaveBeenCalledWith("session-1", true);
		expect(host.emit).toHaveBeenCalledWith({ type: "agent:destroyed", agentId: "session-1" });
		expect(host.emitSessionList).toHaveBeenCalledWith("project-1");
	});

	it("destroyAgent cascades to sub-sessions, disposes runtime and removes stored file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "look-sls-"));
		const path = join(dir, "session.jsonl");
		writeFileSync(path, "", "utf8");

		const stored: StoredSession = {
			id: "session-1",
			name: "s",
			firstMessage: "",
			messageCount: 1,
			created: new Date(),
			modified: new Date(),
			path,
			cwd: dir,
			projectId: "project-1",
			allMessagesText: "",
		};
		const { service, host } = makeService({ stored });

		// The session being destroyed is the active one — activeSessionId should be cleared.
		vi.mocked(host.getActiveSessionId).mockReturnValue("session-1");

		await service.destroyAgent("session-1");

		expect(host.disposeRuntime).toHaveBeenCalledWith("session-1", true);
		expect(existsSync(path)).toBe(false);
		expect(host.setActiveSessionId).toHaveBeenCalledWith(null);
		expect(host.emit).toHaveBeenCalledWith({ type: "agent:destroyed", agentId: "session-1" });
		expect(host.emitSessionList).toHaveBeenCalledWith("project-1");

		rmSync(dir, { recursive: true, force: true });
	});

	it("abortAgent cascades to sub-sessions and aborts the session", async () => {
		const { service, runtime } = makeService();

		await service.abortAgent("session-1");

		expect(runtime.runtime.session.abort).toHaveBeenCalled();
	});

	describe("ensureSessionModel 模型兜底（2026-08-08）", () => {
		const makeDeps = (overrides?: {
			model?: unknown;
			available?: Array<{ provider: string; id: string }>;
			findResult?: unknown;
			preferredModel?: string | null;
			setModelImpl?: () => Promise<void>;
		}) => {
			const setModel = overrides?.setModelImpl ?? vi.fn().mockImplementation(async () => {});
			const update = vi.fn().mockResolvedValue(undefined);
			const session = {
				model: overrides?.model,
				setModel,
			};
			const deps = {
				getAvailableModelsSync: vi.fn().mockReturnValue(overrides?.available ?? []),
				modelRegistry: { find: vi.fn().mockReturnValue(overrides?.findResult ?? null) },
				userSettings: {
					getAll: vi.fn().mockReturnValue({ preferredModel: overrides?.preferredModel ?? null }),
					update,
				},
			};
			return { session, setModel, update, deps };
		};

		it("SDK 未解析出模型时用首个可用模型兜底 setModel", async () => {
			const { session, setModel, deps } = makeDeps({
				available: [{ provider: "deepseek", id: "deepseek-v4-flash" }],
				findResult: { provider: "deepseek", id: "deepseek-v4-flash" },
			});
			await ensureSessionModel(session, deps);
			expect(setModel).toHaveBeenCalledWith({ provider: "deepseek", id: "deepseek-v4-flash" });
		});

		it("已解析出模型时跳过(即使有可用模型)", async () => {
			const { session, setModel, deps } = makeDeps({
				model: { provider: "anthropic", id: "claude-opus-4-8" },
				available: [{ provider: "deepseek", id: "deepseek-v4-flash" }],
			});
			await ensureSessionModel(session, deps);
			expect(setModel).not.toHaveBeenCalled();
		});

		it("兜底 setModel 抛错时不向上抛", async () => {
			const { session, deps } = makeDeps({
				available: [{ provider: "deepseek", id: "deepseek-v4-flash" }],
				findResult: { provider: "deepseek", id: "deepseek-v4-flash" },
				setModelImpl: async () => {
					throw new Error("No API key for provider/model");
				},
			});
			await expect(ensureSessionModel(session, deps)).resolves.toBeUndefined();
		});

		it("无可用模型时不 setModel(保持空模型,由渲染层显示占位文案)", async () => {
			const { session, setModel, deps } = makeDeps({ available: [] });
			await ensureSessionModel(session, deps);
			expect(setModel).not.toHaveBeenCalled();
		});

		it("兜底模型与用户全局默认不同时恢复原默认(防污染)", async () => {
			const { session, setModel, update, deps } = makeDeps({
				preferredModel: "anthropic/claude-opus-4-8",
				available: [{ provider: "deepseek", id: "deepseek-v4-flash" }],
				findResult: { provider: "deepseek", id: "deepseek-v4-flash" },
			});
			await ensureSessionModel(session, deps);
			expect(setModel).toHaveBeenCalledTimes(1);
			// setModel 的 SDK 副作用会覆盖默认模型,兜底后恢复用户设置
			expect(update).toHaveBeenCalledWith({ preferredModel: "anthropic/claude-opus-4-8" });
		});

		it("兜底模型与用户默认一致时不恢复", async () => {
			const { session, update, deps } = makeDeps({
				preferredModel: "deepseek/deepseek-v4-flash",
				available: [{ provider: "deepseek", id: "deepseek-v4-flash" }],
				findResult: { provider: "deepseek", id: "deepseek-v4-flash" },
			});
			await ensureSessionModel(session, deps);
			expect(update).not.toHaveBeenCalled();
		});
	});
});
