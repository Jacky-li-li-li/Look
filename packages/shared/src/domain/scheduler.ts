export type ScheduledTaskStatus = "paused" | "scheduled";
export type ScheduledTaskRunStatus = "running" | "retrying" | "success" | "failed" | "skipped" | "interrupted";
export type TaskRunSource = "scheduled-task" | "manual-task-run" | "manual-task-test";
export type TaskExecutionProfile = "unattended-scheduled-task" | "interactive-test";

export interface ScheduledTaskRetryPolicy {
	maxAttempts: number;
	initialDelayMs: number;
	backoffMultiplier: number;
	maxDelayMs: number;
}

export type ScheduledTaskSchedule =
	| { kind: "once"; runAt: string }
	| { kind: "daily"; time: string }
	| { kind: "weekly"; weekday: number; time: string }
	| { kind: "monthly"; day: number; time: string };

export interface ScheduledTaskNotification {
	enabled: boolean;
	provider: "feishu";
	channelAppId?: string;
	targetChatId?: string;
}

export interface ScheduledTask {
	id: string;
	name: string;
	projectId: string;
	cron: string;
	schedule?: ScheduledTaskSchedule;
	timezone?: string;
	prompt: string;
	parameters: Record<string, string>;
	model?: string;
	notification?: ScheduledTaskNotification;
	status: ScheduledTaskStatus;
	retry: ScheduledTaskRetryPolicy;
	executionTimeoutMs: number;
	createdAt: string;
	updatedAt: string;
	lastRunAt?: string;
	scheduleCompletedAt?: string;
	nextRunAt?: string;
}

export interface ScheduledTaskInput {
	name: string;
	projectId: string;
	cron?: string;
	schedule?: ScheduledTaskSchedule;
	timezone?: string;
	prompt: string;
	parameters?: Record<string, string>;
	model?: string;
	notification?: ScheduledTaskNotification;
	retry?: Partial<ScheduledTaskRetryPolicy>;
	executionTimeoutMs?: number;
}

export interface TaskRun {
	id: string;
	taskId: string;
	taskName: string;
	scheduledAt: string;
	startedAt: string;
	finishedAt?: string;
	status: ScheduledTaskRunStatus;
	attempt: number;
	maxAttempts: number;
	output?: string;
	errorMessage?: string;
	errorStack?: string;
	sessionId?: string;
	notificationStatus?: "sent" | "failed";
	notificationError?: string;
	ownerId: string;
	source?: TaskRunSource;
	executionProfile?: TaskExecutionProfile;
}

export type ScheduledTaskRunLog = TaskRun;

export interface ScheduledTaskTestResult {
	log: TaskRun;
}
