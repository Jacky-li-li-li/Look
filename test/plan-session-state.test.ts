import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionRuntimeManager } from "../src/main/session-runtime-manager";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function createRuntime() {
	const runtime = Object.create(SessionRuntimeManager.prototype) as any;
	runtime.defaultPermissionMode = "ask";
	runtime.permissionModesBySession = new Map([["session-a", "plan"]]);
	runtime.planQuestionsAwaiting = new Map();
	runtime.planApprovalsAwaiting = new Map();
	runtime.planInteractionBySession = new Map();
	runtime.prePlanToolsBySession = new Map();
	runtime.dirtyPlanToolSnapshots = new Set();
	runtime.eventCallbacks = [];
	runtime.runtimes = new Map();
	runtime.permissionAwaiting = new Map();
	runtime.sessionAllowedTools = new Map();
	runtime.dirtyPermissionModes = new Set();
	return runtime;
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
	it("routes question responses by both request and session ID", async () => {
		const runtime = createRuntime();
		const events: any[] = [];
		runtime.eventCallbacks.push((event: any) => events.push(event));
		const pending = runtime.requestPlanQuestions("session-a", questions);
		const request = events.find((event) => event.type === "plan:question-requested").request;

		expect(runtime.handlePlanQuestionResponse({ requestId: request.requestId, sessionId: "session-b", answers: { "Which scope?": "Small" } })).toBe(false);
		expect(runtime.handlePlanQuestionResponse({ requestId: request.requestId, sessionId: "session-a", answers: {} })).toBe(false);
		expect(runtime.handlePlanQuestionResponse({ requestId: request.requestId, sessionId: "session-a", answers: { "Which scope?": "Small" } })).toBe(true);
		await expect(pending).resolves.toEqual({ status: "answered", answers: { "Which scope?": "Small" } });
		expect(runtime.planInteractionBySession.size).toBe(0);
	});

	it("cancels a waiting question before abort can wait on the agent loop", async () => {
		const runtime = createRuntime();
		const pending = runtime.requestPlanQuestions("session-a", questions);
		runtime.cancelPlanInteractions("session-a", "Stopped by user");
		await expect(pending).resolves.toMatchObject({ status: "cancelled", reason: "Stopped by user" });
		expect(runtime.planQuestionsAwaiting.size).toBe(0);
	});

	it("clears pending interactions before awaiting session abort", async () => {
		const runtime = createRuntime();
		const order: string[] = [];
		runtime.cancelPendingPermissions = vi.fn(() => order.push("permissions"));
		runtime.cancelPlanInteractions = vi.fn(() => order.push("plan"));
		runtime.runtimes.set("session-a", {
			runtime: { session: { abort: vi.fn(async () => order.push("abort")) } },
		});
		await runtime.abortAgent("session-a");
		expect(order).toEqual(["permissions", "plan", "abort"]);
	});

	it("manual mode switching cancels Plan interaction, restores tools, then aborts the turn", async () => {
		const runtime = createRuntime();
		const order: string[] = [];
		const session = {
			isStreaming: true,
			getAllTools: () => [{ name: "read" }, { name: "write" }],
			setActiveToolsByName: vi.fn(() => order.push("restore")),
			abort: vi.fn(async () => order.push("abort")),
		};
		const managed = { runtime: { session } };
		runtime.runtimes.set("session-a", managed);
		runtime.ensureRuntime = vi.fn().mockResolvedValue(managed);
		runtime.userSettings = { update: vi.fn().mockResolvedValue(undefined) };
		runtime.persistPermissionModeIfPossible = vi.fn();
		runtime.persistPlanToolSnapshotIfPossible = vi.fn();
		runtime.prePlanToolsBySession.set("session-a", ["read", "write"]);
		const pending = runtime.requestPlanQuestions("session-a", questions);
		await runtime.setPermissionMode("session-a", "ask");
		await expect(pending).resolves.toMatchObject({ status: "cancelled", reason: /changed manually/ });
		expect(order).toEqual(["restore", "abort"]);
		expect(runtime.permissionModesBySession.get("session-a")).toBe("ask");
	});

	it("writes plans atomically under the session-specific path", async () => {
		const runtime = createRuntime();
		const cwd = await mkdtemp(join(tmpdir(), "look-plan-"));
		cleanup.push(cwd);
		const filePath = await runtime.writePlanAtomically("session-a", cwd, "# Plan\n\n1. Test");
		expect(filePath).toBe(join(cwd, ".context", "plan", "session-a.md"));
		expect(await readFile(filePath, "utf8")).toBe("# Plan\n\n1. Test\n");
	});

	it("rejects a symlinked .context plan directory", async () => {
		const runtime = createRuntime();
		const cwd = await mkdtemp(join(tmpdir(), "look-plan-symlink-"));
		const outside = await mkdtemp(join(tmpdir(), "look-plan-outside-"));
		cleanup.push(cwd, outside);
		await mkdir(join(outside, "plan"));
		await symlink(outside, join(cwd, ".context"));
		await expect(runtime.writePlanAtomically("session-a", cwd, "# Plan")).rejects.toThrow(/not a symlink/);
	});

	it("records submitted and rejected approval states while keeping Plan mode", async () => {
		const runtime = createRuntime();
		const cwd = await mkdtemp(join(tmpdir(), "look-plan-approval-"));
		cleanup.push(cwd);
		const sessionManager = SessionManager.inMemory(cwd);
		runtime.runtimes.set("session-a", {
			runtime: { cwd, session: { sessionManager } },
		});
		const events: any[] = [];
		runtime.eventCallbacks.push((event: any) => events.push(event));
		const outcome = runtime.requestPlanApproval("session-a", "# Plan\n\n1. Test");
		await vi.waitFor(() => expect(events.some((event) => event.type === "plan:approval-requested")).toBe(true));
		const request = events.find((event) => event.type === "plan:approval-requested").request;
		await expect(
			runtime.handlePlanApprovalResponse({ requestId: request.requestId, sessionId: "session-b", action: "reject" }),
		).resolves.toBe(false);
		await expect(
			runtime.handlePlanApprovalResponse({ requestId: request.requestId, sessionId: "session-a", action: "reject" }),
		).resolves.toBe(true);
		await expect(outcome).resolves.toMatchObject({ status: "rejected", planId: request.planId });
		const records = sessionManager
			.getEntries()
			.filter((entry: any) => entry.type === "custom" && entry.customType === "look.plan.v1")
			.map((entry: any) => entry.data.status);
		expect(records).toEqual(["submitted", "rejected"]);
		expect(runtime.permissionModesBySession.get("session-a")).toBe("plan");
	});

	it("uses the internal Always transition when approval succeeds", async () => {
		const runtime = createRuntime();
		const cwd = await mkdtemp(join(tmpdir(), "look-plan-approved-"));
		cleanup.push(cwd);
		const sessionManager = SessionManager.inMemory(cwd);
		runtime.runtimes.set("session-a", { runtime: { cwd, session: { sessionManager } } });
		runtime.applyPermissionMode = vi.fn().mockResolvedValue(undefined);
		const events: any[] = [];
		runtime.eventCallbacks.push((event: any) => events.push(event));
		const outcome = runtime.requestPlanApproval("session-a", "# Plan");
		await vi.waitFor(() => expect(events.some((event) => event.type === "plan:approval-requested")).toBe(true));
		const request = events.find((event) => event.type === "plan:approval-requested").request;
		await expect(
			runtime.handlePlanApprovalResponse({ requestId: request.requestId, sessionId: "session-a", action: "approve" }),
		).resolves.toBe(true);
		await expect(outcome).resolves.toMatchObject({ status: "approved", planId: request.planId });
		expect(runtime.applyPermissionMode).toHaveBeenCalledWith("session-a", "always", {
			internal: true,
			updateDefault: false,
		});
		const statuses = sessionManager
			.getEntries()
			.filter((entry: any) => entry.type === "custom" && entry.customType === "look.plan.v1")
			.map((entry: any) => entry.data.status);
		expect(statuses).toEqual(["submitted", "approved"]);
	});

	it("restores only the exact pre-Plan tool snapshot", () => {
		const runtime = createRuntime();
		const setActiveToolsByName = vi.fn();
		runtime.runtimes.set("session-a", {
			runtime: {
				session: {
					getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "mcp:server:tool" }],
					setActiveToolsByName,
				},
			},
		});
		runtime.prePlanToolsBySession.set("session-a", ["read", "write", "removed-tool"]);
		runtime.restorePrePlanTools("session-a");
		expect(setActiveToolsByName).toHaveBeenCalledWith(["read", "write"]);
		expect(runtime.prePlanToolsBySession.has("session-a")).toBe(false);
	});

	it("does not enable read-only built-ins that were disabled before Plan", () => {
		const runtime = createRuntime();
		const setActiveToolsByName = vi.fn();
		runtime.runtimes.set("session-a", {
			runtime: {
				session: {
					getAllTools: () => ["read", "grep", "bash", "AskUserQuestion", "ExitPlanMode"].map((name) => ({ name })),
					setActiveToolsByName,
				},
			},
		});
		runtime.prePlanToolsBySession.set("session-a", ["read", "bash"]);
		runtime.restrictToolsForPlan("session-a");
		expect(setActiveToolsByName).toHaveBeenCalledWith(["read", "bash", "AskUserQuestion", "ExitPlanMode"]);
	});
});
