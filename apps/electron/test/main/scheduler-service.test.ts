import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ScheduledTask, ScheduledTaskInput, ScheduledTaskNotification } from "@look/shared/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ScheduledTaskExecutionContext,
	ScheduledTaskExecutionResult,
	ScheduledTaskExecutor,
} from "../../src/main/scheduler/agent-task-executor.js";
import { cronFromSchedule, SchedulerService } from "../../src/main/scheduler/scheduler-service.js";
import { FileTaskLock } from "../../src/main/scheduler/task-lock.js";
import { ScheduledTaskStore } from "../../src/main/scheduler/task-store.js";

const cleanupPaths: string[] = [];
const services: SchedulerService[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "look-scheduler-test-"));
	cleanupPaths.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.dispose()));
	await Promise.all(cleanupPaths.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	vi.restoreAllMocks();
});

const INPUT: ScheduledTaskInput = {
	name: "Daily summary",
	projectId: "project-1",
	cron: "0 9 * * 1-5",
	timezone: "Asia/Shanghai",
	prompt: "Summarize {{scope}}",
	parameters: { scope: "today" },
	retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2, backoffMultiplier: 2 },
	executionTimeoutMs: 5_000,
};

const defaultProjectInfo = { id: "project-1", name: "Project", cwd: "/tmp/project", valid: true };

function createService(
	dir: string,
	executor: ScheduledTaskExecutor,
	options?: {
		store?: ScheduledTaskStore;
		ownerId?: string;
		getProjectInfo?: (projectId: string) => { valid: boolean; cwd: string } | null;
		resolveNotificationTarget?: (
			notification: ScheduledTaskNotification,
		) => Promise<{ chatId: string; channelAppId?: string } | null | undefined>;
		onAlert?: () => void;
		onFinished?: (event: unknown) => void | Promise<void>;
	},
): SchedulerService {
	const ownerId = options?.ownerId ?? `owner-${Math.random()}`;
	const service = new SchedulerService({
		store: options?.store ?? new ScheduledTaskStore(path.join(dir, "tasks.json")),
		lock: new FileTaskLock(path.join(dir, "locks"), ownerId),
		executor,
		ownerId,
		getProjectInfo: options?.getProjectInfo ?? (() => defaultProjectInfo),
		resolveNotificationTarget: options?.resolveNotificationTarget,
		onAlert: options?.onAlert,
		onFinished: options?.onFinished,
	});
	services.push(service);
	return service;
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for scheduler state");
}

describe("SchedulerService", () => {
	it("does not expose scheduler operations before persisted state is initialized", async () => {
		const dir = await tempDir();
		const service = createService(dir, { execute: vi.fn(async () => ({ output: "ok" })) });
		let ready = false;
		const waiting = service.waitUntilInitialized().then(() => {
			ready = true;
		});

		await Promise.resolve();
		expect(ready).toBe(false);
		await service.initialize();
		await waiting;
		expect(ready).toBe(true);
	});

	it("converts user-friendly plans into recurring cron expressions", () => {
		expect(cronFromSchedule({ kind: "daily", time: "09:30" })).toBe("30 9 * * *");
		expect(cronFromSchedule({ kind: "weekly", weekday: 1, time: "18:05" })).toBe("5 18 * * 1");
		expect(cronFromSchedule({ kind: "monthly", day: 15, time: "08:00" })).toBe("0 8 15 * *");
	});

	it("validates cron expressions and applies lifecycle plus dynamic schedule updates", async () => {
		const dir = await tempDir();
		const executor: ScheduledTaskExecutor = { execute: vi.fn() };
		const service = createService(dir, executor);
		await service.initialize();

		expect(service.validateCron("bad cron").valid).toBe(false);
		expect(service.validateCron("0 9 * * 1-5", "Mars/Olympus").valid).toBe(false);
		expect(service.validateCron("0 9 * * 1-5", "Asia/Shanghai").valid).toBe(true);

		const created = await service.create(INPUT);
		expect(created.status).toBe("paused");
		const started = await service.start(created.id);
		expect(started.status).toBe("scheduled");
		expect(started.nextRunAt).toBeTruthy();

		const updated = await service.update(created.id, { cron: "30 10 * * *", parameters: { scope: "week" } });
		expect(updated.cron).toBe("30 10 * * *");
		expect(updated.parameters).toEqual({ scope: "week" });
		expect(updated.status).toBe("scheduled");
		expect(updated.nextRunAt).toBeTruthy();

		const paused = await service.pause(created.id);
		expect(paused.status).toBe("paused");
		expect(paused.nextRunAt).toBeUndefined();
		expect((await service.resume(created.id)).status).toBe("scheduled");
		await service.delete(created.id);
		expect(service.listTasks()).toEqual([]);
	});

	it("replaces a structured active plan immediately and still supports a legacy cron patch", async () => {
		const dir = await tempDir();
		const service = createService(dir, { execute: vi.fn(async () => ({ output: "ok" })) });
		await service.initialize();
		const task = await service.create({
			...INPUT,
			cron: undefined,
			schedule: { kind: "daily", time: "09:00" },
		});
		await service.start(task.id);

		const weekly = await service.update(task.id, {
			schedule: { kind: "weekly", weekday: 5, time: "17:30" },
		});
		expect(weekly).toMatchObject({
			status: "scheduled",
			cron: "30 17 * * 5",
			schedule: { kind: "weekly", weekday: 5, time: "17:30" },
		});
		expect(weekly.nextRunAt).toBeTruthy();

		const legacy = await service.update(task.id, { cron: "15 8 * * *" });
		expect(legacy.cron).toBe("15 8 * * *");
		expect(legacy.schedule).toBeUndefined();
	});

	it("retries failures with backoff and stores the final output", async () => {
		const dir = await tempDir();
		let attempts = 0;
		const executor: ScheduledTaskExecutor = {
			execute: vi.fn(async (): Promise<ScheduledTaskExecutionResult> => {
				attempts += 1;
				if (attempts < 3) throw new Error(`failure ${attempts}`);
				return { output: "completed", sessionId: "session-1" };
			}),
		};
		const service = createService(dir, executor);
		await service.initialize();
		const task = await service.create(INPUT);

		await service.runNow(task.id);
		await waitFor(() => service.listLogs(task.id)[0]?.status === "success");
		const log = service.listLogs(task.id)[0];
		expect(attempts).toBe(3);
		expect(log).toMatchObject({ status: "success", attempt: 3, output: "completed", sessionId: "session-1" });
	});

	it("tests an unsaved draft immediately without creating a task definition", async () => {
		const dir = await tempDir();
		const executor: ScheduledTaskExecutor = {
			execute: vi.fn(async (task) => ({ output: `tested ${task.model}`, sessionId: "test-session" })),
		};
		const service = createService(dir, executor);
		await service.initialize();

		const result = await service.test({ ...INPUT, model: "openai/gpt-test" });

		expect(result.log).toMatchObject({
			status: "success",
			attempt: 1,
			maxAttempts: 1,
			output: "tested openai/gpt-test",
			sessionId: "test-session",
		});
		expect(service.listTasks()).toEqual([]);
		expect(service.listLogs()).toContainEqual(expect.objectContaining({ id: result.log.id }));
	});

	it("runs an overdue one-time plan once and then pauses it", async () => {
		const dir = await tempDir();
		const executor: ScheduledTaskExecutor = { execute: vi.fn(async () => ({ output: "once" })) };
		const service = createService(dir, executor);
		await service.initialize();
		const task = await service.create({
			...INPUT,
			cron: undefined,
			schedule: { kind: "once", runAt: new Date(Date.now() - 1_000).toISOString() },
		});

		await service.start(task.id);
		await waitFor(() => service.listLogs(task.id)[0]?.status === "success");
		await waitFor(() => service.listTasks().find((item) => item.id === task.id)?.status === "paused");
		expect(executor.execute).toHaveBeenCalledTimes(1);
		await expect(service.start(task.id)).rejects.toThrow("already run");
	});

	it("fires a future one-time plan once at its configured timestamp", async () => {
		const dir = await tempDir();
		const executor: ScheduledTaskExecutor = { execute: vi.fn(async () => ({ output: "future once" })) };
		const service = createService(dir, executor);
		await service.initialize();
		const task = await service.create({
			...INPUT,
			cron: undefined,
			schedule: { kind: "once", runAt: new Date(Date.now() + 100).toISOString() },
		});

		await service.start(task.id);
		await waitFor(() => service.listLogs(task.id)[0]?.status === "success");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(executor.execute).toHaveBeenCalledTimes(1);
		expect(service.listTasks()[0]).toMatchObject({ status: "paused" });
		expect(service.listTasks()[0]?.scheduleCompletedAt).toBeTruthy();
	});

	it("records successful IM delivery after the final task result", async () => {
		const dir = await tempDir();
		const onFinished = vi.fn(async (_event: unknown) => {});
		const executor: ScheduledTaskExecutor = { execute: vi.fn(async () => ({ output: "notify me" })) };
		const service = createService(dir, executor, { onFinished });
		await service.initialize();
		const task = await service.create({
			...INPUT,
			notification: { enabled: true, provider: "feishu", targetChatId: "chat-1" },
		});

		await service.runNow(task.id);
		await waitFor(() => service.listLogs(task.id)[0]?.notificationStatus === "sent");
		expect(onFinished).toHaveBeenCalledTimes(1);
		expect(onFinished).toHaveBeenCalledWith(
			expect.objectContaining({ log: expect.objectContaining({ output: "notify me" }) }),
		);
	});

	it("keeps task success while recording an IM delivery failure", async () => {
		const dir = await tempDir();
		const service = createService(
			dir,
			{ execute: vi.fn(async () => ({ output: "done" })) },
			{
				onFinished: vi.fn(async () => {
					throw new Error("IM offline");
				}),
			},
		);
		await service.initialize();
		const task = await service.create({
			...INPUT,
			notification: { enabled: true, provider: "feishu", targetChatId: "chat-1" },
		});

		await service.runNow(task.id);
		await waitFor(() => service.listLogs(task.id)[0]?.notificationStatus === "failed");
		expect(service.listLogs(task.id)[0]).toMatchObject({
			status: "success",
			notificationStatus: "failed",
			notificationError: "IM offline",
		});
	});

	it("captures stack traces and alerts only after retries are exhausted", async () => {
		const dir = await tempDir();
		const alert = vi.fn();
		const executor: ScheduledTaskExecutor = {
			execute: vi.fn(async () => {
				throw new Error("permanent failure");
			}),
		};
		const service = createService(dir, executor, { onAlert: alert });
		await service.initialize();
		const task = await service.create({ ...INPUT, retry: { ...INPUT.retry, maxAttempts: 2 } });

		await service.runNow(task.id);
		// 服务先写 failed 日志再发 alert（scheduler-service.ts:652-653），
		// 只等日志状态会在慢机器上跑赢 alert，两个条件都要等。
		await waitFor(() => service.listLogs(task.id)[0]?.status === "failed" && alert.mock.calls.length === 1);
		const log = service.listLogs(task.id)[0];
		expect(executor.execute).toHaveBeenCalledTimes(2);
		expect(log.errorMessage).toBe("permanent failure");
		expect(log.errorStack).toContain("permanent failure");
		expect(alert).toHaveBeenCalledTimes(1);
	});

	it("aborts timed-out attempts and still applies the configured retry policy", async () => {
		const dir = await tempDir();
		const executor: ScheduledTaskExecutor = {
			execute: vi.fn(
				async (_task, context) =>
					new Promise((_resolve, reject) => {
						context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
					}),
			),
		};
		const service = createService(dir, executor);
		await service.initialize();
		const task = await service.create({
			...INPUT,
			executionTimeoutMs: 1_000,
			retry: { ...INPUT.retry, maxAttempts: 2, initialDelayMs: 1 },
		});

		await service.runNow(task.id);
		await waitFor(() => service.listLogs(task.id)[0]?.status === "failed", 3_000);
		const log = service.listLogs(task.id)[0];
		expect(executor.execute).toHaveBeenCalledTimes(2);
		expect(log.errorMessage).toContain("timed out after 1000ms");
	});

	it("uses the filesystem lock so only one expanded node executes a task", async () => {
		const dir = await tempDir();
		const firstStore = new ScheduledTaskStore(path.join(dir, "tasks.json"));
		const secondStore = new ScheduledTaskStore(path.join(dir, "tasks.json"));
		let executions = 0;
		const executor: ScheduledTaskExecutor = {
			execute: async () => {
				executions += 1;
				await new Promise((resolve) => setTimeout(resolve, 80));
				return { output: "winner" };
			},
		};
		const first = createService(dir, executor, { store: firstStore, ownerId: "node-a" });
		const second = createService(dir, executor, { store: secondStore, ownerId: "node-b" });
		await first.initialize();
		await second.initialize();
		const task = await first.create(INPUT);

		await first.runNow(task.id);
		await second.runNow(task.id);
		await waitFor(() => firstStore.listLogs(task.id).some((log) => log.status === "success"));
		expect(executions).toBe(1);
		expect(firstStore.listLogs(task.id).some((log) => log.status === "skipped")).toBe(true);
	});

	it("recovers an interrupted run after restart at the next retry attempt", async () => {
		const dir = await tempDir();
		const seedStore = new ScheduledTaskStore(path.join(dir, "tasks.json"));
		seedStore.load();
		const now = new Date().toISOString();
		const task: ScheduledTask = {
			id: "restart-task",
			name: "Restart recovery",
			projectId: "project-1",
			cron: "0 0 1 1 *",
			prompt: "recover",
			parameters: {},
			status: "scheduled",
			retry: { maxAttempts: 3, initialDelayMs: 1, backoffMultiplier: 2, maxDelayMs: 2 },
			executionTimeoutMs: 5_000,
			createdAt: now,
			updatedAt: now,
		};
		await seedStore.upsertTask(task);
		await seedStore.upsertLog({
			id: "old-run",
			taskId: task.id,
			taskName: task.name,
			scheduledAt: now,
			startedAt: now,
			status: "running",
			attempt: 1,
			maxAttempts: 3,
			ownerId: "dead-process",
		});

		const executor: ScheduledTaskExecutor = { execute: vi.fn(async () => ({ output: "recovered" })) };
		const service = createService(dir, executor);
		await service.initialize();
		await waitFor(() => service.listLogs(task.id).some((log) => log.status === "success"));

		const logs = service.listLogs(task.id);
		expect(logs.find((log) => log.id === "old-run")?.status).toBe("interrupted");
		expect(logs.find((log) => log.status === "success")?.attempt).toBe(2);
	});

	it("restores future recurring triggers while recovering an interrupted run", async () => {
		const dir = await tempDir();
		const seedStore = new ScheduledTaskStore(path.join(dir, "tasks.json"));
		seedStore.load();
		const now = new Date().toISOString();
		const task: ScheduledTask = {
			id: "recurring-restart-task",
			name: "Recurring restart recovery",
			projectId: "project-1",
			cron: "* * * * * *",
			prompt: "recover and continue",
			parameters: {},
			status: "scheduled",
			retry: { maxAttempts: 3, initialDelayMs: 1, backoffMultiplier: 2, maxDelayMs: 2 },
			executionTimeoutMs: 5_000,
			createdAt: now,
			updatedAt: now,
		};
		await seedStore.upsertTask(task);
		await seedStore.upsertLog({
			id: "interrupted-recurring-run",
			taskId: task.id,
			taskName: task.name,
			scheduledAt: now,
			startedAt: now,
			status: "running",
			attempt: 1,
			maxAttempts: 3,
			ownerId: "dead-process",
		});

		const executor: ScheduledTaskExecutor = { execute: vi.fn(async () => ({ output: "ok" })) };
		const service = createService(dir, executor);
		await service.initialize();

		await waitFor(() => vi.mocked(executor.execute).mock.calls.length >= 2, 2_500);
		expect(service.listTasks()[0]?.nextRunAt).toBeTruthy();
	});

	it("fires accurately in the real cron loop and stops cleanly when paused", async () => {
		const dir = await tempDir();
		let executions = 0;
		const executor: ScheduledTaskExecutor = {
			execute: async (_task: ScheduledTask, _context: ScheduledTaskExecutionContext) => {
				executions += 1;
				return { output: "tick" };
			},
		};
		const service = createService(dir, executor);
		await service.initialize();
		const task = await service.create({ ...INPUT, cron: "* * * * * *" });
		await service.start(task.id);

		await waitFor(() => executions >= 1, 2_500);
		await service.pause(task.id);
		const countAtPause = executions;
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		expect(executions).toBe(countAtPause);
	});

	it("aborts an in-flight run when the task is deleted", async () => {
		const dir = await tempDir();
		let aborted = false;
		let started = false;
		const executor: ScheduledTaskExecutor = {
			execute: async (_task, context) => {
				started = true;
				return new Promise((resolve) => {
					const timeout = setTimeout(() => resolve({ output: "done" }), 5_000);
					const onAbort = () => {
						clearTimeout(timeout);
						aborted = true;
						resolve({ output: "aborted" });
					};
					context.signal.addEventListener("abort", onAbort, { once: true });
					if (context.signal.aborted) onAbort();
				});
			},
		};
		const service = createService(dir, executor);
		await service.initialize();
		const task = await service.create(INPUT);

		await service.runNow(task.id);
		await waitFor(() => started);
		await service.delete(task.id);

		await waitFor(() => aborted);
		expect(service.listTasks()).toEqual([]);
	});

	it("serializes initialize and dispose calls", async () => {
		const dir = await tempDir();
		const executor: ScheduledTaskExecutor = { execute: vi.fn(async () => ({ output: "ok" })) };
		const service = createService(dir, executor);

		await Promise.all([service.initialize(), service.initialize()]);
		expect(service.listTasks()).toEqual([]);

		await Promise.all([service.dispose(), service.dispose()]);
		await expect(service.initialize()).rejects.toThrow("disposed");
	});

	it("rejects tasks created or updated with a missing or invalid project", async () => {
		const dir = await tempDir();
		const executor: ScheduledTaskExecutor = { execute: vi.fn(async () => ({ output: "ok" })) };
		const getProjectInfo = vi.fn((projectId: string) => {
			if (projectId === "valid-project") return { valid: true, cwd: "/tmp/valid" };
			if (projectId === "invalid-project") return { valid: false, cwd: "/tmp/invalid" };
			return null;
		});
		const service = createService(dir, executor, { getProjectInfo });
		await service.initialize();

		await expect(service.create({ ...INPUT, projectId: "missing-project" })).rejects.toThrow(
			"Project missing-project not found",
		);
		await expect(service.create({ ...INPUT, projectId: "invalid-project" })).rejects.toThrow(
			"Project path does not exist: /tmp/invalid",
		);

		const task = await service.create({ ...INPUT, projectId: "valid-project" });
		await expect(service.update(task.id, { projectId: "missing-project" })).rejects.toThrow(
			"Project missing-project not found",
		);
		await expect(service.update(task.id, { projectId: "invalid-project" })).rejects.toThrow(
			"Project path does not exist: /tmp/invalid",
		);
	});

	it("pauses scheduled tasks whose project is missing on initialize", async () => {
		const dir = await tempDir();
		const seedStore = new ScheduledTaskStore(path.join(dir, "tasks.json"));
		seedStore.load();
		const now = new Date().toISOString();
		const task: ScheduledTask = {
			id: "orphan-task",
			name: "Orphan task",
			projectId: "missing-project",
			cron: "0 0 * * *",
			prompt: "run",
			parameters: {},
			status: "scheduled",
			retry: { maxAttempts: 1, initialDelayMs: 0, backoffMultiplier: 1, maxDelayMs: 0 },
			executionTimeoutMs: 5_000,
			createdAt: now,
			updatedAt: now,
		};
		await seedStore.upsertTask(task);

		const getProjectInfo = vi.fn(() => null);
		const executor: ScheduledTaskExecutor = { execute: vi.fn(async () => ({ output: "ok" })) };
		const service = createService(dir, executor, { store: seedStore, getProjectInfo });
		await service.initialize();

		const paused = service.listTasks()[0];
		expect(paused).toMatchObject({ status: "paused", nextRunAt: undefined });
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("rejects a notification channel whose bot has no private conversation", async () => {
		const dir = await tempDir();
		const executor: ScheduledTaskExecutor = { execute: vi.fn(async () => ({ output: "ok" })) };
		const resolveNotificationTarget = vi.fn(async (notification: ScheduledTaskNotification) => {
			if (notification.channelAppId === "cli_nochat") return null;
			if (notification.channelAppId && notification.targetChatId) {
				return { chatId: notification.targetChatId, channelAppId: notification.channelAppId };
			}
			if (notification.targetChatId) return { chatId: notification.targetChatId };
			return null;
		});
		const service = createService(dir, executor, { resolveNotificationTarget });
		await service.initialize();

		const noChat = {
			enabled: true,
			provider: "feishu" as const,
			channelAppId: "cli_nochat",
			targetChatId: "oc_missing",
		};
		await expect(service.create({ ...INPUT, notification: noChat })).rejects.toThrow("no private conversation");

		const task = await service.create({
			...INPUT,
			notification: { enabled: true, provider: "feishu", channelAppId: "cli_bot", targetChatId: "oc_p2p" },
		});
		expect(task.notification?.channelAppId).toBe("cli_bot");
		expect(task.notification?.targetChatId).toBe("oc_p2p");

		await expect(service.update(task.id, { notification: noChat })).rejects.toThrow("no private conversation");

		// Channel-only targets no longer satisfy input validation; the explicit chat is required.
		await expect(
			service.update(task.id, {
				notification: { enabled: true, provider: "feishu", channelAppId: "cli_bot" },
			}),
		).rejects.toThrow("IM notification target is required");

		// Legacy chatId targets pass through resolution.
		await service.update(task.id, {
			notification: { enabled: true, provider: "feishu", targetChatId: "oc_legacy" },
		});
		// Disabled notifications skip target validation entirely.
		await service.update(task.id, {
			notification: { enabled: false, provider: "feishu", channelAppId: "cli_nochat" },
		});
	});

	it("skips notification target validation when IM is unavailable", async () => {
		const dir = await tempDir();
		const executor: ScheduledTaskExecutor = { execute: vi.fn(async () => ({ output: "ok" })) };
		const service = createService(dir, executor, { resolveNotificationTarget: async () => undefined });
		await service.initialize();
		const task = await service.create({
			...INPUT,
			notification: { enabled: true, provider: "feishu", channelAppId: "cli_anything", targetChatId: "oc_p2p" },
		});
		expect(task.notification?.enabled).toBe(true);
	});

	it("deletes all tasks bound to a project", async () => {
		const dir = await tempDir();
		const executor: ScheduledTaskExecutor = { execute: vi.fn(async () => ({ output: "ok" })) };
		const service = createService(dir, executor);
		await service.initialize();

		const keep = await service.create({ ...INPUT, projectId: "project-keep" });
		await service.create({ ...INPUT, projectId: "project-remove" });
		await service.deleteTasksByProject("project-remove");

		expect(service.listTasks().map((t) => t.id)).toEqual([keep.id]);
	});

	it("marks orphaned unfinished logs as interrupted on initialize", async () => {
		const dir = await tempDir();
		const seedStore = new ScheduledTaskStore(path.join(dir, "tasks.json"));
		seedStore.load();
		const now = new Date().toISOString();
		await seedStore.upsertLog({
			id: "orphan-run",
			taskId: "deleted-task",
			taskName: "Deleted task",
			scheduledAt: now,
			startedAt: now,
			status: "running",
			attempt: 1,
			maxAttempts: 3,
			ownerId: "dead-process",
		});

		const executor: ScheduledTaskExecutor = { execute: vi.fn(async () => ({ output: "ok" })) };
		const service = createService(dir, executor);
		await service.initialize();

		expect(service.listLogs().find((log) => log.id === "orphan-run")?.status).toBe("interrupted");
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it("recovers only the newest interrupted run when a task has several", async () => {
		const dir = await tempDir();
		const seedStore = new ScheduledTaskStore(path.join(dir, "tasks.json"));
		seedStore.load();
		const older = new Date(Date.now() - 60_000).toISOString();
		const now = new Date().toISOString();
		const task: ScheduledTask = {
			id: "multi-crash-task",
			name: "Multi crash recovery",
			projectId: "project-1",
			cron: "0 0 1 1 *",
			prompt: "recover",
			parameters: {},
			status: "scheduled",
			retry: { maxAttempts: 3, initialDelayMs: 1, backoffMultiplier: 2, maxDelayMs: 2 },
			executionTimeoutMs: 5_000,
			createdAt: now,
			updatedAt: now,
		};
		await seedStore.upsertTask(task);
		await seedStore.upsertLog({
			id: "older-run",
			taskId: task.id,
			taskName: task.name,
			scheduledAt: older,
			startedAt: older,
			status: "running",
			attempt: 1,
			maxAttempts: 3,
			ownerId: "dead-process",
		});
		await seedStore.upsertLog({
			id: "newer-run",
			taskId: task.id,
			taskName: task.name,
			scheduledAt: now,
			startedAt: now,
			status: "running",
			attempt: 2,
			maxAttempts: 3,
			ownerId: "dead-process",
		});

		const executor: ScheduledTaskExecutor = { execute: vi.fn(async () => ({ output: "recovered" })) };
		const service = createService(dir, executor);
		await service.initialize();
		await waitFor(() => service.listLogs(task.id).some((log) => log.status === "success"));

		const logs = service.listLogs(task.id);
		expect(logs.find((log) => log.id === "older-run")?.status).toBe("interrupted");
		expect(logs.find((log) => log.id === "newer-run")?.status).toBe("interrupted");
		// The retry chain resumes from the newest run, so already-consumed attempts
		// are not spent twice.
		expect(logs.find((log) => log.status === "success")?.attempt).toBe(3);
		expect(executor.execute).toHaveBeenCalledTimes(1);
	});

	it("does not discard a one-time plan that was edited while its run was in flight", async () => {
		const dir = await tempDir();
		let started = false;
		let releaseRun!: () => void;
		const runGate = new Promise<void>((resolve) => {
			releaseRun = resolve;
		});
		const executor: ScheduledTaskExecutor = {
			execute: vi.fn(async () => {
				started = true;
				await runGate;
				return { output: "once" };
			}),
		};
		const service = createService(dir, executor);
		await service.initialize();
		const task = await service.create({
			...INPUT,
			cron: undefined,
			schedule: { kind: "once", runAt: new Date(Date.now() - 1_000).toISOString() },
		});

		await service.start(task.id);
		await waitFor(() => started);

		// Move the plan to a future date while the overdue run is still executing.
		const futureRunAt = new Date(Date.now() + 60 * 60_000).toISOString();
		await service.update(task.id, { schedule: { kind: "once", runAt: futureRunAt } });

		releaseRun();
		await waitFor(() => service.listLogs(task.id)[0]?.status === "success");
		// Give the completion handler a chance to (incorrectly) consume the new plan.
		await new Promise((resolve) => setTimeout(resolve, 100));

		const current = service.listTasks().find((item) => item.id === task.id);
		expect(current).toMatchObject({ status: "scheduled", schedule: { kind: "once", runAt: futureRunAt } });
		expect(current?.scheduleCompletedAt).toBeUndefined();
		expect(current?.nextRunAt).toBe(futureRunAt);
	});

	it("consumes a one-time plan when run now so it does not fire again", async () => {
		const dir = await tempDir();
		const executor: ScheduledTaskExecutor = { execute: vi.fn(async () => ({ output: "ran now" })) };
		const service = createService(dir, executor);
		await service.initialize();
		const task = await service.create({
			...INPUT,
			cron: undefined,
			schedule: { kind: "once", runAt: new Date(Date.now() + 250).toISOString() },
		});
		await service.start(task.id);

		await service.runNow(task.id);
		await waitFor(() => service.listLogs(task.id)[0]?.status === "success");
		await waitFor(() => service.listTasks().find((item) => item.id === task.id)?.status === "paused");

		// The original timestamp must not trigger a second execution.
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(executor.execute).toHaveBeenCalledTimes(1);
		expect(service.listTasks().find((item) => item.id === task.id)?.scheduleCompletedAt).toBeTruthy();
	});

	it("does not fire the original one-time timer while a manual run outlasts it", async () => {
		const dir = await tempDir();
		let started = false;
		let releaseRun!: () => void;
		const runGate = new Promise<void>((resolve) => {
			releaseRun = resolve;
		});
		const executor: ScheduledTaskExecutor = {
			execute: vi.fn(async () => {
				started = true;
				await runGate;
				return { output: "ran now" };
			}),
		};
		const service = createService(dir, executor);
		await service.initialize();
		const task = await service.create({
			...INPUT,
			cron: undefined,
			schedule: { kind: "once", runAt: new Date(Date.now() + 150).toISOString() },
		});
		await service.start(task.id);

		await service.runNow(task.id);
		await waitFor(() => started);

		// The original timestamp passes while the manual run is still in flight:
		// no competing execution, no skipped log, and the task is not paused early.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(executor.execute).toHaveBeenCalledTimes(1);
		expect(service.listLogs(task.id).some((log) => log.status === "skipped")).toBe(false);
		expect(service.listTasks().find((item) => item.id === task.id)?.status).toBe("scheduled");

		releaseRun();
		await waitFor(() => service.listLogs(task.id)[0]?.status === "success");
		await waitFor(() => service.listTasks().find((item) => item.id === task.id)?.status === "paused");
		expect(executor.execute).toHaveBeenCalledTimes(1);
	});

	it("files a test run under the given task so it appears in that task's history", async () => {
		const dir = await tempDir();
		const executor: ScheduledTaskExecutor = { execute: vi.fn(async () => ({ output: "tested" })) };
		const service = createService(dir, executor);
		await service.initialize();
		const task = await service.create(INPUT);

		const result = await service.test({ ...INPUT, prompt: "draft edit" }, task.id);

		expect(result.log.taskId).toBe(task.id);
		expect(service.listLogs(task.id).some((log) => log.id === result.log.id)).toBe(true);
		expect(service.listTasks()).toHaveLength(1);

		// An unknown task id still produces an unattached test log instead of failing.
		const orphan = await service.test(INPUT, "missing-task");
		expect(orphan.log.taskId).not.toBe("missing-task");
	});

	it("sizes the coordination lock lease for the worst-case run duration", async () => {
		const dir = await tempDir();
		const acquire = vi.spyOn(FileTaskLock.prototype, "acquire");
		const executor: ScheduledTaskExecutor = { execute: vi.fn(async () => ({ output: "ok" })) };
		const service = createService(dir, executor);
		await service.initialize();
		const task = await service.create({
			...INPUT,
			retry: { maxAttempts: 4, initialDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 2_000 },
			executionTimeoutMs: 10_000,
		});

		await service.runNow(task.id);
		await waitFor(() => service.listLogs(task.id)[0]?.status === "success");

		expect(acquire).toHaveBeenCalledWith(task.id, 4 * (10_000 + 2_000) + 60_000);
	});
});
