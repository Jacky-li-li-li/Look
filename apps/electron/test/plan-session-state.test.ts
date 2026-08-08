import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IEventBus, IRuntimeStore } from "../src/main/core/contracts";
import { PlanService } from "../src/main/permissions/plan.js";
import { PermissionService } from "../src/main/permissions/service.js";

const cleanup: string[] = [];
afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface MockAgentSession {
	getActiveToolNames: () => string[];
	getAllTools: () => { name: string }[];
	setActiveToolsByName: ReturnType<typeof vi.fn>;
	sessionManager: SessionManager & {
		isPersisted: () => boolean;
		appendCustomEntry: ReturnType<typeof vi.fn>;
	};
	abort: ReturnType<typeof vi.fn>;
	isStreaming: boolean;
}

type MockSessionOpts = {
	setActiveToolsByName?: ReturnType<typeof vi.fn>;
	getAllTools?: () => { name: string }[];
	getActiveToolNames?: () => string[];
	sessionManager?: SessionManager;
	cwd?: string;
	isStreaming?: boolean;
	abort?: ReturnType<typeof vi.fn>;
};

function mockSession(opts: MockSessionOpts = {}): MockAgentSession {
	return {
		getActiveToolNames: opts.getActiveToolNames ?? (() => []),
		getAllTools: opts.getAllTools ?? (() => []),
		setActiveToolsByName: opts.setActiveToolsByName ?? vi.fn(),
		sessionManager:
			opts.sessionManager ??
			({
				isPersisted: () => false,
				appendCustomEntry: () => {},
			} as MockAgentSession["sessionManager"]),
		abort: opts.abort ?? vi.fn(),
		isStreaming: opts.isStreaming ?? false,
	} as MockAgentSession;
}

function planServiceForTest(
	extraSessions?: Record<string, { cwd: string; sessionManager?: SessionManager; session?: MockAgentSession }>,
): {
	runtimeStore: IRuntimeStore;
	permissionSvc: PermissionService;
	planSvc: PlanService;
	events: unknown[];
	onApproval: ReturnType<typeof vi.fn>;
} {
	const events: unknown[] = [];
	const eventBus: IEventBus = {
		emit(event) {
			events.push(event);
		},
		onEvent() {
			return () => {};
		},
	};
	const sessions = new Map<string, { cwd: string; sessionManager?: SessionManager; session: MockAgentSession }>();
	for (const [id, s] of Object.entries(extraSessions ?? {})) {
		sessions.set(id, s as { cwd: string; sessionManager?: SessionManager; session: MockAgentSession });
	}
	const runtimeStore: IRuntimeStore = {
		getRuntime: () => undefined as unknown as AgentSessionRuntime,
		getSession: (id) =>
			(sessions.get(id)?.session ??
				mockSession({ sessionManager: sessions.get(id)?.sessionManager })) as unknown as AgentSession,
		getSessionManager: (id) => sessions.get(id)?.sessionManager,
		getCwd: (id) => sessions.get(id)?.cwd ?? "/tmp",
		getProjectRoot: () => "/tmp",
	};
	const permissionSvc = new PermissionService(eventBus, "ask");
	permissionSvc.setMode("session-a", "plan");
	const onApproval = vi.fn().mockResolvedValue(undefined);
	const planSvc = new PlanService(eventBus, runtimeStore, permissionSvc, onApproval);
	return { runtimeStore, permissionSvc, planSvc, events, onApproval };
}

const questions = [
	{
		question: "Which scope?",
		header: "Scope",
		options: [
			{ label: "Small", description: "Minimal change" },
			{ label: "Large", description: "Broad change" },
		],
	},
];

describe("Plan session state", () => {
	it("persists a dirty tool snapshot to the explicitly supplied session manager", () => {
		const appendPrevious = vi.fn();
		const appendCurrent = vi.fn();
		const previousManager = {
			isPersisted: () => true,
			appendCustomEntry: appendPrevious,
		} as unknown as SessionManager;
		const currentManager = {
			isPersisted: () => true,
			appendCustomEntry: appendCurrent,
		} as unknown as SessionManager;
		const { planSvc } = planServiceForTest({
			"session-a": {
				cwd: "/tmp",
				sessionManager: currentManager,
				session: mockSession({ getActiveToolNames: () => ["read"] }),
			},
		});

		planSvc.capturePrePlanTools("session-a");
		planSvc.persistToolSnapshotIfDirty("session-a", previousManager);

		expect(appendPrevious).toHaveBeenCalledTimes(1);
		expect(appendCurrent).not.toHaveBeenCalled();
	});

	it("routes question responses by both request and session ID", async () => {
		const events: unknown[] = [];
		const eb: IEventBus = {
			emit(e) {
				events.push(e);
			},
			onEvent() {
				return () => {};
			},
		};
		const rs: IRuntimeStore = {
			getRuntime: () => undefined as unknown as AgentSessionRuntime,
			getSession: () => mockSession() as unknown as AgentSession,
			getSessionManager: () => undefined,
			getCwd: () => "/tmp",
			getProjectRoot: () => "/tmp",
		};
		const ps = new PermissionService(eb, "ask");
		ps.setMode("session-a", "plan");
		const svc = new PlanService(eb, rs, ps, async () => {});
		const pending = svc.requestQuestions("session-a", questions);
		const request = (
			events.find(
				(e) => (e as Record<string, { request: { requestId: string } }>)?.type === "plan:question-requested",
			) as Record<string, { request: { requestId: string } }>
		).request;

		expect(
			svc.handleQuestionResponse({
				requestId: request.requestId,
				sessionId: "session-b",
				answers: { "Which scope?": "Small" },
			}),
		).toBe(false);
		expect(svc.handleQuestionResponse({ requestId: request.requestId, sessionId: "session-a", answers: {} })).toBe(
			false,
		);
		expect(
			svc.handleQuestionResponse({
				requestId: request.requestId,
				sessionId: "session-a",
				answers: { "Which scope?": "Small" },
			}),
		).toBe(true);
		await expect(pending).resolves.toEqual({ status: "answered", answers: { "Which scope?": "Small" } });
	});

	it("asks questions outside Plan mode (always/ask sessions)", async () => {
		const events: unknown[] = [];
		const eb: IEventBus = {
			emit(e) {
				events.push(e);
			},
			onEvent() {
				return () => {};
			},
		};
		const rs: IRuntimeStore = {
			getRuntime: () => undefined as unknown as AgentSessionRuntime,
			getSession: () => mockSession() as unknown as AgentSession,
			getSessionManager: () => undefined,
			getCwd: () => "/tmp",
			getProjectRoot: () => "/tmp",
		};
		const ps = new PermissionService(eb, "ask");
		// 不切换到 plan 模式 —— AskUserQuestion 在 ask/always 模式同样可用
		const svc = new PlanService(eb, rs, ps, async () => {});
		const pending = svc.requestQuestions("session-a", questions);
		const request = (
			events.find(
				(e) => (e as Record<string, { request: { requestId: string } }>)?.type === "plan:question-requested",
			) as Record<string, { request: { requestId: string } }>
		).request;

		expect(request).toBeDefined();
		expect(
			svc.handleQuestionResponse({
				requestId: request.requestId,
				sessionId: "session-a",
				answers: { "Which scope?": "Small" },
			}),
		).toBe(true);
		await expect(pending).resolves.toEqual({ status: "answered", answers: { "Which scope?": "Small" } });
	});

	it("asks questions in always mode and keeps ExitPlanMode Plan-only", async () => {
		const events: unknown[] = [];
		const eb: IEventBus = {
			emit(e) {
				events.push(e);
			},
			onEvent() {
				return () => {};
			},
		};
		const rs: IRuntimeStore = {
			getRuntime: () => undefined as unknown as AgentSessionRuntime,
			getSession: () => mockSession() as unknown as AgentSession,
			getSessionManager: () => undefined,
			getCwd: () => "/tmp",
			getProjectRoot: () => "/tmp",
		};
		const ps = new PermissionService(eb, "always");
		const svc = new PlanService(eb, rs, ps, async () => {});

		const pending = svc.requestQuestions("session-a", questions);
		const request = (
			events.find(
				(e) => (e as Record<string, { request: { requestId: string } }>)?.type === "plan:question-requested",
			) as Record<string, { request: { requestId: string } }>
		).request;
		expect(request).toBeDefined();
		expect(
			svc.handleQuestionResponse({
				requestId: request.requestId,
				sessionId: "session-a",
				answers: { "Which scope?": "Small" },
			}),
		).toBe(true);
		await expect(pending).resolves.toEqual({ status: "answered", answers: { "Which scope?": "Small" } });

		// ExitPlanMode stays Plan-only: non-plan sessions are rejected at the service layer.
		await expect(svc.requestApproval("session-a", "# Plan")).resolves.toMatchObject({
			status: "cancelled",
			reason: "Session is no longer in Plan mode",
		});
	});

	it("settles pending questions when the session is disposed", async () => {
		const { planSvc } = planServiceForTest();
		const pending = planSvc.requestQuestions("session-a", questions);
		planSvc.disposeSession("session-a");
		await expect(pending).resolves.toMatchObject({ status: "cancelled", reason: "Session disposed" });
	});

	it("times out unanswered questions with the main-process fallback timer", async () => {
		vi.useFakeTimers();
		try {
			const { planSvc } = planServiceForTest();
			const pending = planSvc.requestQuestions("session-a", questions);
			vi.advanceTimersByTime(5 * 60 * 1000);
			await expect(pending).resolves.toMatchObject({
				status: "cancelled",
				reason: "Question timed out after 5 minutes",
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels a waiting question before abort can wait on the agent loop", async () => {
		const { planSvc } = planServiceForTest();
		const pending = planSvc.requestQuestions("session-a", questions);
		planSvc.cancelInteractions("session-a", "Stopped by user");
		await expect(pending).resolves.toMatchObject({ status: "cancelled", reason: "Stopped by user" });
	});

	it("manual mode switching restores tools", async () => {
		const order: string[] = [];
		const session = mockSession({
			getActiveToolNames: () => ["read", "write"],
			getAllTools: () => [{ name: "read" }, { name: "write" }],
			setActiveToolsByName: vi.fn(() => order.push("restore")),
			abort: vi.fn(async () => order.push("abort")),
			isStreaming: true,
		});
		const rs: IRuntimeStore = {
			getRuntime: () => undefined as unknown as AgentSessionRuntime,
			getSession: (id) => (id === "session-a" ? session : mockSession()) as unknown as AgentSession,
			getSessionManager: () => undefined,
			getCwd: () => "/tmp",
			getProjectRoot: () => "/tmp",
		};
		const ps = new PermissionService(
			{
				emit() {},
				onEvent() {
					return () => {};
				},
			},
			"ask",
		);
		ps.setMode("session-a", "plan");
		const planSvc = new PlanService(
			{
				emit() {},
				onEvent() {
					return () => {};
				},
			},
			rs,
			ps,
			async () => {},
		);

		planSvc.capturePrePlanTools("session-a");

		const pending = planSvc.requestQuestions("session-a", questions);
		ps.setMode("session-a", "ask");
		planSvc.restorePrePlanTools("session-a");
		planSvc.cancelInteractions("session-a", "Permission mode was changed manually");
		await expect(pending).resolves.toMatchObject({ status: "cancelled", reason: /changed manually/ });
		expect(order).toEqual(["restore"]);
		expect(ps.getMode("session-a")).toBe("ask");
	});

	it("rejects a symlinked .context plan directory", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "look-plan-symlink-"));
		const outside = await mkdtemp(join(tmpdir(), "look-plan-outside-"));
		cleanup.push(cwd, outside);
		await mkdir(join(outside, "plan"));
		await symlink(outside, join(cwd, ".context"));

		const rs: IRuntimeStore = {
			getRuntime: () => undefined as unknown as AgentSessionRuntime,
			getSession: () => mockSession() as unknown as AgentSession,
			getSessionManager: () => undefined,
			getCwd: () => cwd,
			getProjectRoot: () => cwd,
		};
		const ps = new PermissionService(
			{
				emit() {},
				onEvent() {
					return () => {};
				},
			},
			"ask",
		);
		ps.setMode("session-a", "plan");
		const planSvc = new PlanService(
			{
				emit() {},
				onEvent() {
					return () => {};
				},
			},
			rs,
			ps,
			async () => {},
		);
		await expect(planSvc.requestApproval("session-a", "# Plan")).rejects.toThrow(/not a symlink/);
	});

	it("records submitted and rejected approval states while keeping Plan mode", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "look-plan-approval-"));
		cleanup.push(cwd);
		const sessionManager = SessionManager.inMemory(cwd);
		const session = mockSession({ sessionManager });

		const events: unknown[] = [];
		const eb: IEventBus = {
			emit(e) {
				events.push(e);
			},
			onEvent() {
				return () => {};
			},
		};
		const rs: IRuntimeStore = {
			getRuntime: () => undefined as unknown as AgentSessionRuntime,
			getSession: () => session as unknown as AgentSession,
			getSessionManager: () => sessionManager,
			getCwd: () => cwd,
			getProjectRoot: () => cwd,
		};
		const ps = new PermissionService(eb, "ask");
		ps.setMode("session-a", "plan");
		const planSvc = new PlanService(eb, rs, ps, async () => {});

		const outcome = planSvc.requestApproval("session-a", "# Plan\n\n1. Test");
		await vi.waitFor(() =>
			expect(events.some((e) => (e as Record<string, unknown>)?.type === "plan:approval-requested")).toBe(true),
		);
		const request = (
			events.find(
				(e) => (e as Record<string, { request: Record<string, unknown> }>)?.type === "plan:approval-requested",
			) as Record<string, { request: Record<string, unknown> }>
		).request;

		// Wrong session
		await expect(
			planSvc.handleApprovalResponse({ requestId: request.requestId, sessionId: "session-b", action: "reject" }),
		).resolves.toBe(false);
		// Correct session
		await expect(
			planSvc.handleApprovalResponse({ requestId: request.requestId, sessionId: "session-a", action: "reject" }),
		).resolves.toBe(true);
		await expect(outcome).resolves.toMatchObject({ status: "rejected", planId: request.planId });

		const records = sessionManager
			.getEntries()
			.filter(
				(entry) =>
					(entry as Record<string, unknown>).type === "custom" &&
					(entry as Record<string, { customType: string }>).customType === "look.plan.v1",
			)
			.map((entry) => (entry as Record<string, { data: { status: string } }>).data.status);
		expect(records).toEqual(["submitted", "rejected"]);
		expect(ps.getMode("session-a")).toBe("plan");
	});

	it("uses the internal Always transition when approval succeeds", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "look-plan-approved-"));
		cleanup.push(cwd);
		const sessionManager = SessionManager.inMemory(cwd);
		const session = mockSession({ sessionManager });

		const events: unknown[] = [];
		const eb: IEventBus = {
			emit(e) {
				events.push(e);
			},
			onEvent() {
				return () => {};
			},
		};
		const rs: IRuntimeStore = {
			getRuntime: () => undefined as unknown as AgentSessionRuntime,
			getSession: () => session as unknown as AgentSession,
			getSessionManager: () => sessionManager,
			getCwd: () => cwd,
			getProjectRoot: () => cwd,
		};
		const ps = new PermissionService(eb, "ask");
		ps.setMode("session-a", "plan");
		const onApproval = vi.fn(async () => {
			ps.setMode("session-a", "always");
		});
		const planSvc = new PlanService(eb, rs, ps, onApproval);

		const outcome = planSvc.requestApproval("session-a", "# Plan");
		await vi.waitFor(() =>
			expect(events.some((e) => (e as Record<string, unknown>)?.type === "plan:approval-requested")).toBe(true),
		);
		const request = (
			events.find(
				(e) => (e as Record<string, { request: Record<string, unknown> }>)?.type === "plan:approval-requested",
			) as Record<string, { request: Record<string, unknown> }>
		).request;

		await expect(
			planSvc.handleApprovalResponse({ requestId: request.requestId, sessionId: "session-a", action: "approve" }),
		).resolves.toBe(true);
		await expect(outcome).resolves.toMatchObject({ status: "approved", planId: request.planId });
		expect(onApproval).toHaveBeenCalledWith("session-a");

		const statuses = sessionManager
			.getEntries()
			.filter(
				(entry) =>
					(entry as Record<string, unknown>).type === "custom" &&
					(entry as Record<string, { customType: string }>).customType === "look.plan.v1",
			)
			.map((entry) => (entry as Record<string, { data: { status: string } }>).data.status);
		expect(statuses).toEqual(["submitted", "approved"]);
	});

	it("restores only the exact pre-Plan tool snapshot", () => {
		const setActiveToolsByName = vi.fn();
		const session = mockSession({
			getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "mcp:server:tool" }],
			setActiveToolsByName,
		});
		const rs: IRuntimeStore = {
			getRuntime: () => undefined as unknown as AgentSessionRuntime,
			getSession: () => session as unknown as AgentSession,
			getSessionManager: () => undefined,
			getCwd: () => "/tmp",
			getProjectRoot: () => "/tmp",
		};
		const ps = new PermissionService(
			{
				emit() {},
				onEvent() {
					return () => {};
				},
			},
			"ask",
		);
		const planSvc = new PlanService(
			{
				emit() {},
				onEvent() {
					return () => {};
				},
			},
			rs,
			ps,
			async () => {},
		);
		planSvc.capturePrePlanTools("session-a");
		(planSvc as unknown as { prePlanTools: Map<string, string[]> }).prePlanTools.set("session-a", [
			"read",
			"write",
			"removed-tool",
		]);
		planSvc.restorePrePlanTools("session-a");
		expect(setActiveToolsByName).toHaveBeenCalledWith(["read", "write"]);
	});

	it("does not enable read-only built-ins that were disabled before Plan", () => {
		const setActiveToolsByName = vi.fn();
		const session = mockSession({
			getAllTools: () => ["read", "grep", "bash", "AskUserQuestion", "ExitPlanMode"].map((name) => ({ name })),
			getActiveToolNames: () => ["read", "bash"],
			setActiveToolsByName,
		});
		const rs: IRuntimeStore = {
			getRuntime: () => undefined as unknown as AgentSessionRuntime,
			getSession: () => session as unknown as AgentSession,
			getSessionManager: () => undefined,
			getCwd: () => "/tmp",
			getProjectRoot: () => "/tmp",
		};
		const ps = new PermissionService(
			{
				emit() {},
				onEvent() {
					return () => {};
				},
			},
			"ask",
		);
		const planSvc = new PlanService(
			{
				emit() {},
				onEvent() {
					return () => {};
				},
			},
			rs,
			ps,
			async () => {},
		);
		planSvc.capturePrePlanTools("session-a");
		planSvc.restrictToolsForPlan("session-a");
		expect(setActiveToolsByName).toHaveBeenCalledWith(["read", "bash", "AskUserQuestion", "ExitPlanMode"]);
	});
});
