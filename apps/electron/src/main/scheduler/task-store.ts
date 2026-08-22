import type { ScheduledTask, ScheduledTaskRunLog } from "@look/shared/types";
import { LockedJsonStore } from "../utils/locked-json-store.js";

interface ScheduledTaskDatabase {
	version: 1;
	tasks: ScheduledTask[];
	logs: ScheduledTaskRunLog[];
}

const EMPTY_DATABASE: ScheduledTaskDatabase = { version: 1, tasks: [], logs: [] };

/** Small, atomic JSON store. All mutations are serialized to prevent lost updates. */
export class ScheduledTaskStore extends LockedJsonStore<ScheduledTaskDatabase> {
	constructor(
		filePath: string,
		private readonly maxLogs = 2_000,
	) {
		super(filePath, EMPTY_DATABASE, "ScheduledTaskStore");
	}

	protected normalizeDatabase(raw: unknown): ScheduledTaskDatabase {
		const loaded = (raw ?? {}) as Partial<ScheduledTaskDatabase>;
		return {
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
}
