import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ScheduledTask, ScheduledTaskRunLog } from "@look/shared/types";
import { readJsonFile } from "../utils/atomic-writer.js";
import { type AcquiredTaskLock, FileTaskLock } from "./task-lock.js";

interface ScheduledTaskDatabase {
	version: 1;
	tasks: ScheduledTask[];
	logs: ScheduledTaskRunLog[];
}

const EMPTY_DATABASE: ScheduledTaskDatabase = { version: 1, tasks: [], logs: [] };

/** Small, atomic JSON store. All mutations are serialized to prevent lost updates. */
export class ScheduledTaskStore {
	private database: ScheduledTaskDatabase = structuredClone(EMPTY_DATABASE);
	private mutationQueue: Promise<void> = Promise.resolve();
	private readonly mutationLock: FileTaskLock;

	constructor(
		private readonly filePath: string,
		private readonly maxLogs = 2_000,
	) {
		this.mutationLock = new FileTaskLock(`${filePath}.locks`, `${process.pid}:${randomUUID()}`);
	}

	load(): void {
		const loaded = readJsonFile<ScheduledTaskDatabase>(this.filePath, structuredClone(EMPTY_DATABASE));
		this.database = {
			version: 1,
			tasks: Array.isArray(loaded.tasks) ? loaded.tasks : [],
			logs: Array.isArray(loaded.logs)
				? loaded.logs.map((log) => ({
						...log,
						source: log.source ?? "scheduled-task",
						executionProfile: log.executionProfile ?? "unattended-scheduled-task",
					}))
				: [],
		};
	}

	listTasks(): ScheduledTask[] {
		this.load();
		return structuredClone(this.database.tasks);
	}

	getTask(taskId: string): ScheduledTask | undefined {
		this.load();
		const task = this.database.tasks.find((item) => item.id === taskId);
		return task ? structuredClone(task) : undefined;
	}

	listLogs(taskId?: string, limit = 100): ScheduledTaskRunLog[] {
		this.load();
		const numericLimit = typeof limit === "number" && Number.isFinite(limit) ? limit : 100;
		const safeLimit = Math.max(1, Math.min(1_000, Math.floor(numericLimit)));
		return structuredClone(
			this.database.logs
				.filter((log) => !taskId || log.taskId === taskId)
				.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
				.slice(0, safeLimit),
		);
	}

	async upsertTask(task: ScheduledTask): Promise<void> {
		await this.mutate((database) => {
			const index = database.tasks.findIndex((item) => item.id === task.id);
			if (index >= 0) database.tasks[index] = structuredClone(task);
			else database.tasks.push(structuredClone(task));
		});
	}

	async deleteTask(taskId: string): Promise<void> {
		await this.mutate((database) => {
			database.tasks = database.tasks.filter((task) => task.id !== taskId);
		});
	}

	async upsertLog(log: ScheduledTaskRunLog): Promise<void> {
		const normalized: ScheduledTaskRunLog = {
			...log,
			source: log.source ?? "scheduled-task",
			executionProfile: log.executionProfile ?? "unattended-scheduled-task",
		};
		await this.mutate((database) => {
			const index = database.logs.findIndex((item) => item.id === normalized.id);
			if (index >= 0) database.logs[index] = structuredClone(normalized);
			else database.logs.push(structuredClone(normalized));
			database.logs = database.logs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, this.maxLogs);
		});
	}

	listUnfinishedLogs(): ScheduledTaskRunLog[] {
		this.load();
		return structuredClone(this.database.logs.filter((log) => log.status === "running" || log.status === "retrying"));
	}

	async markInterrupted(logId: string, now = new Date()): Promise<ScheduledTaskRunLog | null> {
		let interrupted: ScheduledTaskRunLog | null = null;
		await this.mutate((database) => {
			const log = database.logs.find((item) => item.id === logId);
			if (!log || (log.status !== "running" && log.status !== "retrying")) return;
			log.status = "interrupted";
			log.finishedAt = now.toISOString();
			log.errorMessage = "Application stopped before the scheduled task completed";
			interrupted = structuredClone(log);
		});
		return interrupted;
	}

	private async mutate(update: (database: ScheduledTaskDatabase) => void): Promise<void> {
		const operation = this.mutationQueue.then(async () => {
			const lock = await this.acquireMutationLock();
			try {
				// Refresh inside the cross-process critical section so independent
				// Look processes merge mutations instead of overwriting one another.
				this.load();
				const draft = structuredClone(this.database);
				update(draft);
				await this.writeDatabase(draft);
				this.database = draft;
			} finally {
				await lock.release();
			}
		});
		this.mutationQueue = operation.catch((error) => {
			console.error("[ScheduledTaskStore] Mutation failed:", error);
		});
		await operation;
	}

	private async acquireMutationLock(): Promise<AcquiredTaskLock> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const lock = await this.mutationLock.acquire("database", 30_000);
			if (lock) return lock;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`Timed out waiting for scheduled-task storage lock: ${this.filePath}`);
	}

	private async writeDatabase(database: ScheduledTaskDatabase): Promise<void> {
		await mkdir(path.dirname(this.filePath), { recursive: true });
		const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporaryPath, JSON.stringify(database, null, "\t"), "utf8");
			await rename(temporaryPath, this.filePath);
		} finally {
			await rm(temporaryPath, { force: true }).catch(() => {});
		}
	}
}
