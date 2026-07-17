import { randomUUID } from "node:crypto";
import type {
	ProjectInfo,
	ScheduledTask,
	ScheduledTaskInput,
	ScheduledTaskNotification,
	ScheduledTaskRetryPolicy,
	ScheduledTaskRunLog,
	ScheduledTaskSchedule,
	ScheduledTaskTestResult,
} from "@look/shared/types";
import cron, { type ScheduledTask as CronTask } from "node-cron";
import type { ScheduledTaskExecutor } from "./agent-task-executor.js";
import type { FileTaskLock } from "./task-lock.js";
import type { ScheduledTaskStore } from "./task-store.js";

const DEFAULT_RETRY: ScheduledTaskRetryPolicy = {
	maxAttempts: 3,
	initialDelayMs: 5_000,
	backoffMultiplier: 2,
	maxDelayMs: 60_000,
};
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const MAX_LOG_OUTPUT_CHARS = 100_000;
const MAX_LOG_STACK_CHARS = 30_000;

export interface ScheduledTaskAlert {
	task: ScheduledTask;
	log: ScheduledTaskRunLog;
}

export interface SchedulerServiceOptions {
	store: ScheduledTaskStore;
	lock: FileTaskLock;
	executor: ScheduledTaskExecutor;
	ownerId?: string;
	/** Project lookup used to validate task projectIds and pause tasks whose project was removed. */
	getProjectInfo: (projectId: string) => ProjectInfo | null | undefined;
	/**
	 * Resolve the deliverable chat target for a notification config: a
	 * channel-based notification is mapped to the bot's p2p conversation with
	 * the user, a legacy targetChatId passes through. Return null when the
	 * target cannot be resolved (e.g. the user never messaged the bot
	 * privately); return undefined when IM is unavailable and validation must
	 * be skipped instead of blocking the save.
	 */
	resolveNotificationTarget?: (
		notification: ScheduledTaskNotification,
	) => Promise<{ chatId: string; channelAppId?: string } | null | undefined>;
	onAlert?: (alert: ScheduledTaskAlert) => void | Promise<void>;
	onFinished?: (event: ScheduledTaskAlert) => void | Promise<void>;
}

function parseTime(time: string): { hour: number; minute: number } {
	const match = /^(\d{2}):(\d{2})$/.exec(time);
	if (!match) throw new Error("Schedule time must use HH:mm format");
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error("Schedule time is invalid");
	return { hour, minute };
}

export function cronFromSchedule(schedule: ScheduledTaskSchedule): string {
	if (schedule.kind === "once") {
		const runAt = new Date(schedule.runAt);
		if (Number.isNaN(runAt.getTime())) throw new Error("One-time run date is invalid");
		return `${runAt.getMinutes()} ${runAt.getHours()} ${runAt.getDate()} ${runAt.getMonth() + 1} *`;
	}
	const { hour, minute } = parseTime(schedule.time);
	if (schedule.kind === "daily") return `${minute} ${hour} * * *`;
	if (schedule.kind === "weekly") {
		if (!Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6) {
			throw new Error("Weekly schedule weekday must be between 0 and 6");
		}
		return `${minute} ${hour} * * ${schedule.weekday}`;
	}
	if (schedule.kind === "monthly") {
		if (!Number.isInteger(schedule.day) || schedule.day < 1 || schedule.day > 31) {
			throw new Error("Monthly schedule day must be between 1 and 31");
		}
		return `${minute} ${hour} ${schedule.day} * *`;
	}
	throw new Error("Unsupported task schedule frequency");
}

function normalizeRetry(input?: Partial<ScheduledTaskRetryPolicy>): ScheduledTaskRetryPolicy {
	const finite = (value: number | undefined, fallback: number) =>
		typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return {
		maxAttempts: Math.max(1, Math.min(20, Math.floor(finite(input?.maxAttempts, DEFAULT_RETRY.maxAttempts)))),
		initialDelayMs: Math.max(
			0,
			Math.min(24 * 60 * 60_000, finite(input?.initialDelayMs, DEFAULT_RETRY.initialDelayMs)),
		),
		backoffMultiplier: Math.max(1, Math.min(10, finite(input?.backoffMultiplier, DEFAULT_RETRY.backoffMultiplier))),
		maxDelayMs: Math.max(0, Math.min(24 * 60 * 60_000, finite(input?.maxDelayMs, DEFAULT_RETRY.maxDelayMs))),
	};
}

function validateTimezone(timezone?: string): void {
	if (!timezone) return;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
	} catch {
		throw new Error(`Invalid IANA timezone: ${timezone}`);
	}
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
		if (!signal) return;
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("Aborted"));
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

function truncateLogValue(value: string | undefined, maxChars: number): string | undefined {
	if (!value || value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}\n… [truncated by Look]`;
}

export class SchedulerService {
	private readonly schedules = new Map<string, CronTask>();
	private readonly oneTimeTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly activeRuns = new Map<string, AbortController>(); // runId -> controller
	private readonly taskRuns = new Map<string, Set<string>>(); // taskId -> runIds
	private readonly runPromises = new Set<Promise<unknown>>();
	private readonly ownerId: string;
	private initialized = false;
	private disposed = false;
	private lifecycleLock: Promise<void> = Promise.resolve();
	private initializationError: unknown;
	private readonly initializationSignal: Promise<void>;
	private resolveInitialization!: () => void;

	constructor(private readonly options: SchedulerServiceOptions) {
		this.ownerId = options.ownerId ?? `${process.pid}:${randomUUID()}`;
		this.initializationSignal = new Promise((resolve) => {
			this.resolveInitialization = resolve;
		});
	}

	async initialize(): Promise<void> {
		try {
			await this.withLifecycle(async () => {
				if (this.initialized) return;
				if (this.disposed) throw new Error("Scheduler service has been disposed");
				this.options.store.load();
				const recoverable = new Map<string, ScheduledTaskRunLog>();
				for (const unfinished of this.options.store.listUnfinishedLogs()) {
					const task = this.options.store.getTask(unfinished.taskId);
					if (!task) {
						// Orphaned run (task deleted, or a test draft that was never saved):
						// close it out so it does not stay "running" in the log forever.
						await this.options.store.markInterrupted(unfinished.id);
						continue;
					}
					const recoveryLock = await this.options.lock.acquire(task.id, this.leaseMsFor(task));
					// A live owner means another expanded node is still executing this run.
					if (!recoveryLock) continue;
					const interrupted = await this.options.store.markInterrupted(unfinished.id);
					await recoveryLock.release();
					if (!interrupted) continue;
					// Several crashes in a row can leave multiple unfinished logs for one
					// task. Only the newest one resumes the retry chain; older ones stay
					// interrupted so attempts are not consumed twice.
					const previous = recoverable.get(interrupted.taskId);
					if (
						!previous ||
						interrupted.attempt > previous.attempt ||
						(interrupted.attempt === previous.attempt && interrupted.scheduledAt > previous.scheduledAt)
					) {
						recoverable.set(interrupted.taskId, interrupted);
					}
				}

				for (const task of this.options.store.listTasks()) {
					if (task.status !== "scheduled") continue;
					const proj = this.options.getProjectInfo(task.projectId);
					if (!proj || !proj.valid) {
						console.warn(
							`[SchedulerService] Pausing task "${task.name}" because project ${task.projectId} ` +
								(!proj ? "no longer exists" : `path does not exist: ${proj.cwd}`),
						);
						task.status = "paused";
						task.nextRunAt = undefined;
						task.updatedAt = new Date().toISOString();
						await this.options.store.upsertTask(task);
						continue;
					}
					const interrupted = recoverable.get(task.id);
					if (task.schedule?.kind === "once") {
						const isDue = new Date(task.schedule.runAt).getTime() <= Date.now();
						if (task.scheduleCompletedAt) {
							task.status = "paused";
							task.nextRunAt = undefined;
							await this.options.store.upsertTask(task);
						} else if (interrupted && isDue) {
							// Recovery is started below. Do not also launch the overdue plan.
						} else if (isDue) {
							const runAt = task.schedule.runAt;
							void this.startExecution(task.id, new Date(runAt)).finally(() =>
								this.completeOneTime(task.id, runAt),
							);
						} else {
							await this.installSchedule(task);
						}
					} else {
						// Recurring plans must be restored even when an interrupted run also
						// needs recovery, otherwise the task silently stops after the retry.
						await this.installSchedule(task);
					}
				}
				this.initialized = true;

				for (const log of recoverable.values()) {
					const task = this.options.store.getTask(log.taskId);
					if (task?.status !== "scheduled") continue;
					if (log.attempt < task.retry.maxAttempts) {
						const recovery = this.startExecution(task.id, new Date(log.scheduledAt), log.attempt + 1);
						if (task.schedule?.kind === "once") {
							void recovery.finally(() => this.completeOneTime(task.id, log.scheduledAt));
						}
					} else {
						await this.alertFailure(task, log);
						await this.notifyFinished(task, log);
						if (task.schedule?.kind === "once") await this.completeOneTime(task.id);
					}
				}
			});
			this.initializationError = undefined;
		} catch (error) {
			this.initializationError = error;
			throw error;
		} finally {
			this.resolveInitialization();
		}
	}

	async waitUntilInitialized(): Promise<void> {
		await this.initializationSignal;
		if (this.initializationError) throw this.initializationError;
		if (!this.initialized) throw new Error("Scheduler service is not available");
	}

	listTasks(): ScheduledTask[] {
		return this.options.store.listTasks().map((task) => this.withNextRun(task));
	}

	listLogs(taskId?: string, limit?: number): ScheduledTaskRunLog[] {
		return this.options.store.listLogs(taskId, limit);
	}

	validateCron(expression: string, timezone?: string): { valid: boolean; error?: string; nextRunAt?: string } {
		try {
			validateTimezone(timezone);
			if (!cron.validate(expression)) return { valid: false, error: "Invalid cron expression" };
			const probe = cron.createTask(expression, () => {}, { timezone });
			const nextRunAt = probe.getNextRun()?.toISOString();
			void probe.destroy();
			return { valid: true, nextRunAt };
		} catch (error) {
			return { valid: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async create(input: ScheduledTaskInput): Promise<ScheduledTask> {
		const task = this.buildTask(input);
		await this.assertNotificationTarget(input);
		await this.options.store.upsertTask(task);
		return task;
	}

	async update(taskId: string, patch: Partial<ScheduledTaskInput>): Promise<ScheduledTask> {
		const current = this.requireTask(taskId);
		const mergedInput: ScheduledTaskInput = {
			name: patch.name ?? current.name,
			projectId: patch.projectId ?? current.projectId,
			cron: patch.cron ?? current.cron,
			schedule: "schedule" in patch ? patch.schedule : "cron" in patch ? undefined : current.schedule,
			timezone: "timezone" in patch ? patch.timezone : current.timezone,
			prompt: patch.prompt ?? current.prompt,
			parameters: patch.parameters ?? current.parameters,
			model: "model" in patch ? patch.model : current.model,
			notification: "notification" in patch ? patch.notification : current.notification,
			retry: patch.retry ? { ...current.retry, ...patch.retry } : current.retry,
			executionTimeoutMs: patch.executionTimeoutMs ?? current.executionTimeoutMs,
		};
		const cronExpression = this.resolveCron(mergedInput);
		this.assertInput(mergedInput, cronExpression);
		await this.assertNotificationTarget(mergedInput);
		const updated: ScheduledTask = {
			...current,
			...mergedInput,
			name: mergedInput.name.trim(),
			cron: cronExpression,
			schedule: mergedInput.schedule ? structuredClone(mergedInput.schedule) : undefined,
			timezone: mergedInput.timezone?.trim() || undefined,
			parameters: structuredClone(mergedInput.parameters ?? {}),
			model: mergedInput.model?.trim() || undefined,
			notification: mergedInput.notification ? structuredClone(mergedInput.notification) : undefined,
			retry: normalizeRetry(mergedInput.retry),
			executionTimeoutMs: Math.min(
				MAX_TIMEOUT_MS,
				Math.max(1_000, mergedInput.executionTimeoutMs ?? DEFAULT_TIMEOUT_MS),
			),
			updatedAt: new Date().toISOString(),
		};
		if ("schedule" in patch || "cron" in patch) delete updated.scheduleCompletedAt;
		await this.options.store.upsertTask(updated);
		if (updated.status === "scheduled") {
			if (updated.schedule?.kind === "once" && new Date(updated.schedule.runAt).getTime() <= Date.now()) {
				await this.removeSchedule(updated.id);
				const runAt = updated.schedule.runAt;
				void this.startExecution(updated.id, new Date(runAt)).finally(() =>
					this.completeOneTime(updated.id, runAt),
				);
			} else {
				await this.installSchedule(updated);
			}
		}
		return this.withNextRun(updated);
	}

	async start(taskId: string): Promise<ScheduledTask> {
		const task = this.requireTask(taskId);
		if (task.schedule?.kind === "once" && task.scheduleCompletedAt) {
			throw new Error("This one-time task has already run; choose a new date before starting it again");
		}
		const updated = { ...task, status: "scheduled" as const, updatedAt: new Date().toISOString() };
		if (updated.schedule?.kind === "once" && new Date(updated.schedule.runAt).getTime() <= Date.now()) {
			await this.options.store.upsertTask(updated);
			const runAt = updated.schedule.runAt;
			void this.startExecution(updated.id, new Date(runAt)).finally(() => this.completeOneTime(updated.id, runAt));
		} else {
			await this.installSchedule(updated);
			await this.options.store.upsertTask(this.withNextRun(updated));
		}
		return this.withNextRun(updated);
	}

	async pause(taskId: string): Promise<ScheduledTask> {
		const task = this.requireTask(taskId);
		await this.removeSchedule(taskId);
		const updated = { ...task, status: "paused" as const, nextRunAt: undefined, updatedAt: new Date().toISOString() };
		await this.options.store.upsertTask(updated);
		return updated;
	}

	async resume(taskId: string): Promise<ScheduledTask> {
		return this.start(taskId);
	}

	async delete(taskId: string): Promise<void> {
		this.requireTask(taskId);
		await this.removeSchedule(taskId);
		for (const runId of this.taskRuns.get(taskId) ?? []) {
			this.activeRuns.get(runId)?.abort(new Error("Scheduled task was deleted"));
		}
		await this.options.store.deleteTask(taskId);
	}

	async deleteTasksByProject(projectId: string): Promise<void> {
		for (const task of this.options.store.listTasks()) {
			if (task.projectId !== projectId) continue;
			// 每个 task 独立 try-catch：一个 task 删除失败不应阻止同 project 的其他 task 被清理
			try {
				await this.delete(task.id);
			} catch (error) {
				console.error(
					`[SchedulerService] Failed to delete scheduled task "${task.name}" (${task.id}) ` +
						`during project ${projectId} cleanup:`,
					error,
				);
			}
		}
	}

	runNow(taskId: string): { accepted: true } {
		const task = this.requireTask(taskId);
		// 同步校验 project 是否仍然存在：避免前端显示"已接受执行"后立即失败
		if (this.options.getProjectInfo) {
			const project = this.options.getProjectInfo(task.projectId);
			if (!project) {
				throw new Error(
					`Project not found for scheduled task "${task.name}" (projectId: ${task.projectId}). ` +
						`The project may have been deleted; please edit the task and select a valid project.`,
				);
			}
			if (!project.valid) {
				throw new Error(
					`Project path does not exist for scheduled task "${task.name}": ${project.cwd}. ` +
						`The project folder is missing; please restore it or select a different project.`,
				);
			}
		}
		const execution = this.startExecution(taskId, new Date());
		// A manual run of a one-time plan consumes it; the timer must not fire again later.
		if (task.schedule?.kind === "once") {
			const runAt = task.schedule.runAt;
			void execution.finally(() => this.completeOneTime(taskId, runAt));
		}
		return { accepted: true };
	}

	/** Execute an unsaved draft once and return its final persisted test log. */
	async test(input: ScheduledTaskInput, taskId?: string): Promise<ScheduledTaskTestResult> {
		const execution = this.executeTest(input, taskId);
		this.runPromises.add(execution);
		try {
			return await execution;
		} finally {
			this.runPromises.delete(execution);
		}
	}

	private async executeTest(input: ScheduledTaskInput, taskId?: string): Promise<ScheduledTaskTestResult> {
		if (this.disposed) throw new Error("Scheduler service has been disposed");
		const task = this.buildTask(input);
		await this.assertNotificationTarget(input);
		// File the test run under the existing task so it appears in that task's history.
		if (taskId && this.options.store.getTask(taskId)) task.id = taskId;
		const controller = new AbortController();
		const startedAt = new Date().toISOString();
		const log: ScheduledTaskRunLog = {
			id: randomUUID(),
			taskId: task.id,
			taskName: task.name,
			scheduledAt: startedAt,
			startedAt,
			status: "running",
			attempt: 1,
			maxAttempts: 1,
			ownerId: this.ownerId,
		};
		this.activeRuns.set(log.id, controller);
		const taskRunSet = this.taskRuns.get(task.id) ?? new Set<string>();
		taskRunSet.add(log.id);
		this.taskRuns.set(task.id, taskRunSet);
		await this.options.store.upsertLog(log);

		const timeout = setTimeout(
			() => controller.abort(new Error(`Scheduled task test timed out after ${task.executionTimeoutMs}ms`)),
			task.executionTimeoutMs,
		);
		timeout.unref?.();
		try {
			const result = await this.options.executor.execute(task, {
				runId: log.id,
				attempt: 1,
				signal: controller.signal,
			});
			log.status = "success";
			log.output = truncateLogValue(result.output, MAX_LOG_OUTPUT_CHARS);
			log.sessionId = result.sessionId;
		} catch (error) {
			log.status = controller.signal.aborted ? "interrupted" : "failed";
			log.errorMessage = error instanceof Error ? error.message : String(error);
			log.errorStack = truncateLogValue(error instanceof Error ? error.stack : undefined, MAX_LOG_STACK_CHARS);
		} finally {
			clearTimeout(timeout);
			log.finishedAt = new Date().toISOString();
			this.activeRuns.delete(log.id);
			this.taskRuns.get(task.id)?.delete(log.id);
			await this.options.store.upsertLog(log);
		}
		await this.notifyFinished(task, log);
		return { log: structuredClone(log) };
	}

	async dispose(): Promise<void> {
		await this.withLifecycle(async () => {
			if (this.disposed) return;
			this.disposed = true;
			for (const controller of this.activeRuns.values()) {
				controller.abort(new Error("Scheduler is shutting down"));
			}
			const scheduledIds = new Set([...this.schedules.keys(), ...this.oneTimeTimers.keys()]);
			await Promise.all([...scheduledIds].map((taskId) => this.removeSchedule(taskId)));
			await Promise.allSettled([...this.runPromises]);
			this.initialized = false;
			this.resolveInitialization();
		});
	}

	private async withLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		const locked = this.lifecycleLock.then(() => operation());
		this.lifecycleLock = locked.catch(() => {}) as Promise<void>;
		return locked;
	}

	private async installSchedule(task: ScheduledTask): Promise<void> {
		await this.removeSchedule(task.id);
		if (task.schedule?.kind === "once") {
			this.installOneTimeTimer(task);
			return;
		}
		const scheduled = cron.createTask(
			task.cron,
			async (context) => {
				const current = this.options.store.getTask(task.id);
				if (current?.status !== "scheduled") return;
				await this.startExecution(task.id, context.date);
			},
			{
				timezone: task.timezone,
				name: `look:${task.id}`,
				noOverlap: true,
				unref: true,
			},
		);
		this.schedules.set(task.id, scheduled);
		await scheduled.start();
	}

	private installOneTimeTimer(task: ScheduledTask): void {
		if (task.schedule?.kind !== "once") return;
		const runAt = task.schedule.runAt;
		const remaining = new Date(runAt).getTime() - Date.now();
		const timer = setTimeout(
			() => {
				this.oneTimeTimers.delete(task.id);
				if (remaining > MAX_TIMER_DELAY_MS) {
					this.installOneTimeTimer(task);
					return;
				}
				const current = this.options.store.getTask(task.id);
				if (current?.status !== "scheduled") return;
				void this.startExecution(task.id, new Date(runAt)).finally(() => this.completeOneTime(task.id, runAt));
			},
			Math.max(0, Math.min(remaining, MAX_TIMER_DELAY_MS)),
		);
		timer.unref?.();
		this.oneTimeTimers.set(task.id, timer);
	}

	private async completeOneTime(taskId: string, expectedRunAt?: string): Promise<void> {
		const task = this.options.store.getTask(taskId);
		if (!task || task.schedule?.kind !== "once") return;
		// The plan changed while this run was in flight (e.g. the user edited runAt);
		// completing now would silently discard the new schedule and its timer.
		if (expectedRunAt && new Date(task.schedule.runAt).getTime() !== new Date(expectedRunAt).getTime()) return;
		task.status = "paused";
		task.scheduleCompletedAt = new Date().toISOString();
		task.nextRunAt = undefined;
		task.updatedAt = new Date().toISOString();
		await this.options.store.upsertTask(task);
		await this.removeSchedule(taskId);
	}

	/** Worst-case duration of one full run: one timeout per attempt plus retry delays. */
	private leaseMsFor(task: ScheduledTask): number {
		return task.retry.maxAttempts * (task.executionTimeoutMs + task.retry.maxDelayMs) + 60_000;
	}

	private startExecution(taskId: string, scheduledAt: Date, startAttempt = 1): Promise<void> {
		const execution = this.execute(taskId, scheduledAt, startAttempt).catch((error) => {
			console.error(`[SchedulerService] Task ${taskId} execution infrastructure failed:`, error);
		});
		this.runPromises.add(execution);
		void execution.finally(() => this.runPromises.delete(execution));
		return execution;
	}

	private async removeSchedule(taskId: string): Promise<void> {
		const timer = this.oneTimeTimers.get(taskId);
		if (timer) {
			clearTimeout(timer);
			this.oneTimeTimers.delete(taskId);
		}
		const existing = this.schedules.get(taskId);
		if (!existing) return;
		this.schedules.delete(taskId);
		await existing.destroy();
	}

	private async execute(taskId: string, scheduledAt: Date, startAttempt = 1): Promise<void> {
		if (this.disposed) return;
		const task = this.options.store.getTask(taskId);
		if (!task) return;
		// 防御性校验 project：如果 project 已不在或路径无效，
		// 提前退出避免浪费锁、创建无意义的 running log 和无效重试
		if (this.options.getProjectInfo) {
			const project = this.options.getProjectInfo(task.projectId);
			if (!project?.valid) {
				console.warn(
					`[SchedulerService] Skipping execution of task "${task.name}" ` +
						`because project ${task.projectId} no longer exists or its path is missing`,
				);
				task.status = "paused";
				task.nextRunAt = undefined;
				task.updatedAt = new Date().toISOString();
				await this.options.store.upsertTask(task);
				await this.removeSchedule(taskId);
				await this.options.store.upsertLog({
					id: randomUUID(),
					taskId,
					taskName: task.name,
					scheduledAt: scheduledAt.toISOString(),
					startedAt: new Date().toISOString(),
					finishedAt: new Date().toISOString(),
					status: "failed",
					attempt: 0,
					maxAttempts: task.retry.maxAttempts,
					errorMessage: project
						? `Project path does not exist: ${project.cwd}`
						: `Project ${task.projectId} no longer exists`,
					ownerId: this.ownerId,
				});
				return;
			}
		}
		const leaseMs = this.leaseMsFor(task);
		const lock = await this.options.lock.acquire(taskId, leaseMs);
		if (!lock) {
			const now = new Date().toISOString();
			await this.options.store.upsertLog({
				id: randomUUID(),
				taskId,
				taskName: task.name,
				scheduledAt: scheduledAt.toISOString(),
				startedAt: now,
				finishedAt: now,
				status: "skipped",
				attempt: 0,
				maxAttempts: task.retry.maxAttempts,
				errorMessage: "Skipped because another process or node owns this task lock",
				ownerId: this.ownerId,
			});
			return;
		}

		const controller = new AbortController();
		const startedAt = new Date().toISOString();
		const log: ScheduledTaskRunLog = {
			id: randomUUID(),
			taskId,
			taskName: task.name,
			scheduledAt: scheduledAt.toISOString(),
			startedAt,
			status: "running",
			attempt: startAttempt,
			maxAttempts: task.retry.maxAttempts,
			ownerId: this.ownerId,
		};
		this.activeRuns.set(log.id, controller);
		const taskRunSet = this.taskRuns.get(taskId) ?? new Set();
		taskRunSet.add(log.id);
		this.taskRuns.set(taskId, taskRunSet);
		await this.options.store.upsertLog(log);

		try {
			for (let attempt = startAttempt; attempt <= task.retry.maxAttempts; attempt += 1) {
				log.attempt = attempt;
				log.status = attempt === startAttempt ? "running" : "retrying";
				await this.options.store.upsertLog(log);
				const attemptController = new AbortController();
				const abortAttempt = () =>
					attemptController.abort(controller.signal.reason ?? new Error("Scheduled task execution was aborted"));
				if (controller.signal.aborted) abortAttempt();
				else controller.signal.addEventListener("abort", abortAttempt, { once: true });
				const timeout = setTimeout(
					() => attemptController.abort(new Error(`Scheduled task timed out after ${task.executionTimeoutMs}ms`)),
					task.executionTimeoutMs,
				);
				timeout.unref?.();
				try {
					const result = await this.options.executor.execute(task, {
						runId: log.id,
						attempt,
						signal: attemptController.signal,
					});
					clearTimeout(timeout);
					controller.signal.removeEventListener("abort", abortAttempt);
					log.status = "success";
					log.output = truncateLogValue(result.output, MAX_LOG_OUTPUT_CHARS);
					log.sessionId = result.sessionId;
					log.finishedAt = new Date().toISOString();
					delete log.errorMessage;
					delete log.errorStack;
					await this.options.store.upsertLog(log);
					await this.notifyFinished(task, log);
					break;
				} catch (error) {
					clearTimeout(timeout);
					controller.signal.removeEventListener("abort", abortAttempt);
					log.errorMessage = error instanceof Error ? error.message : String(error);
					log.errorStack = truncateLogValue(error instanceof Error ? error.stack : undefined, MAX_LOG_STACK_CHARS);
					if (attempt >= task.retry.maxAttempts || controller.signal.aborted) {
						log.status = controller.signal.aborted ? "interrupted" : "failed";
						log.finishedAt = new Date().toISOString();
						await this.options.store.upsertLog(log);
						if (log.status === "failed") await this.alertFailure(task, log);
						await this.notifyFinished(task, log);
						break;
					}
					log.status = "retrying";
					await this.options.store.upsertLog(log);
					const retryDelay = Math.min(
						task.retry.maxDelayMs,
						task.retry.initialDelayMs * task.retry.backoffMultiplier ** (attempt - 1),
					);
					try {
						await delay(retryDelay, controller.signal);
					} catch (error) {
						log.status = "interrupted";
						log.finishedAt = new Date().toISOString();
						log.errorMessage = error instanceof Error ? error.message : String(error);
						log.errorStack = truncateLogValue(
							error instanceof Error ? error.stack : undefined,
							MAX_LOG_STACK_CHARS,
						);
						await this.options.store.upsertLog(log);
						break;
					}
				}
			}
		} finally {
			this.activeRuns.delete(log.id);
			this.taskRuns.get(taskId)?.delete(log.id);
			await lock.release();
			const latest = this.options.store.getTask(taskId);
			if (latest) {
				latest.lastRunAt = log.finishedAt ?? new Date().toISOString();
				latest.nextRunAt = this.schedules.get(taskId)?.getNextRun()?.toISOString();
				await this.options.store.upsertTask(latest);
			}
		}
	}

	private requireTask(taskId: string): ScheduledTask {
		const task = this.options.store.getTask(taskId);
		if (!task) throw new Error(`Scheduled task ${taskId} not found`);
		return task;
	}

	private withNextRun(task: ScheduledTask): ScheduledTask {
		if (task.status === "scheduled" && task.schedule?.kind === "once") {
			return { ...task, nextRunAt: task.schedule.runAt };
		}
		const nextRunAt =
			task.status === "scheduled" ? this.schedules.get(task.id)?.getNextRun()?.toISOString() : undefined;
		return { ...task, nextRunAt };
	}

	private async notifyFinished(task: ScheduledTask, log: ScheduledTaskRunLog): Promise<void> {
		if (!task.notification?.enabled || !this.options.onFinished) return;
		try {
			await this.options.onFinished({ task, log: structuredClone(log) });
			log.notificationStatus = "sent";
			delete log.notificationError;
		} catch (error) {
			log.notificationStatus = "failed";
			log.notificationError = error instanceof Error ? error.message : String(error);
		}
		await this.options.store.upsertLog(log);
	}

	private async alertFailure(task: ScheduledTask, log: ScheduledTaskRunLog): Promise<void> {
		try {
			await this.options.onAlert?.({ task, log: structuredClone(log) });
		} catch (error) {
			console.error(`[SchedulerService] Failed to deliver alert for task ${task.id}:`, error);
		}
	}

	private resolveCron(input: ScheduledTaskInput): string {
		if (input.schedule) return cronFromSchedule(input.schedule);
		if (input.cron?.trim()) return input.cron.trim();
		throw new Error("Task schedule is required");
	}

	private buildTask(input: ScheduledTaskInput): ScheduledTask {
		const cronExpression = this.resolveCron(input);
		this.assertInput(input, cronExpression);
		const now = new Date().toISOString();
		return {
			id: randomUUID(),
			name: input.name.trim(),
			projectId: input.projectId.trim(),
			cron: cronExpression,
			schedule: input.schedule ? structuredClone(input.schedule) : undefined,
			timezone: input.timezone?.trim() || undefined,
			prompt: input.prompt,
			parameters: structuredClone(input.parameters ?? {}),
			model: input.model?.trim() || undefined,
			notification: input.notification ? structuredClone(input.notification) : undefined,
			status: "paused",
			retry: normalizeRetry(input.retry),
			executionTimeoutMs: Math.min(MAX_TIMEOUT_MS, Math.max(1_000, input.executionTimeoutMs ?? DEFAULT_TIMEOUT_MS)),
			createdAt: now,
			updatedAt: now,
		};
	}

	private assertInput(input: ScheduledTaskInput, cronExpression: string): void {
		if (!input.name?.trim()) throw new Error("Task name is required");
		if (!input.projectId?.trim()) throw new Error("Project is required");
		if (this.options.getProjectInfo) {
			const project = this.options.getProjectInfo(input.projectId.trim());
			if (!project) throw new Error(`Project ${input.projectId.trim()} not found`);
			if (!project.valid) throw new Error(`Project path does not exist: ${project.cwd}`);
		}
		if (!input.prompt?.trim()) throw new Error("Task prompt is required");
		if (
			input.parameters !== undefined &&
			(typeof input.parameters !== "object" ||
				Array.isArray(input.parameters) ||
				Object.values(input.parameters).some((value) => typeof value !== "string"))
		) {
			throw new Error("Task parameters must be a string-to-string object");
		}
		if (input.model !== undefined && !input.model.trim()) throw new Error("Task model cannot be empty");
		if (
			input.notification?.enabled &&
			!input.notification.channelAppId?.trim() &&
			!input.notification.targetChatId?.trim()
		) {
			throw new Error("IM notification target is required");
		}
		if (input.notification && input.notification.provider !== "feishu") {
			throw new Error("Unsupported IM notification provider");
		}
		const validation = this.validateCron(cronExpression, input.timezone);
		if (!validation.valid) throw new Error(validation.error ?? "Invalid cron expression");
		if (input.executionTimeoutMs !== undefined && !Number.isFinite(input.executionTimeoutMs)) {
			throw new Error("Execution timeout must be a finite number");
		}
	}

	/**
	 * Verify an enabled notification can actually be delivered: the selected bot
	 * must have a private conversation with the user. Legacy chatId targets and
	 * an unavailable IM bridge pass through.
	 */
	private async assertNotificationTarget(input: ScheduledTaskInput): Promise<void> {
		const notification = input.notification;
		if (!notification?.enabled || !this.options.resolveNotificationTarget) return;
		const resolved = await this.options.resolveNotificationTarget(notification);
		if (resolved === null) {
			throw new Error(
				"The selected bot has no private conversation with you yet; " +
					"message it once in Feishu, then enable IM notification",
			);
		}
	}
}
