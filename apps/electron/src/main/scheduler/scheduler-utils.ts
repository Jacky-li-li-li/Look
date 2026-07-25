// ============================================================
// Scheduler utility functions — extracted from scheduler-service.ts
// ============================================================

import type { ScheduledTaskRetryPolicy, ScheduledTaskSchedule } from "@look/shared/types";

export const DEFAULT_RETRY: ScheduledTaskRetryPolicy = {
	maxAttempts: 3,
	initialDelayMs: 5_000,
	backoffMultiplier: 2,
	maxDelayMs: 60_000,
};
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;
export const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
export const MAX_TIMER_DELAY_MS = 2_147_000_000;
export const MAX_LOG_OUTPUT_CHARS = 100_000;
export const MAX_LOG_STACK_CHARS = 30_000;

export function parseTime(time: string): { hour: number; minute: number } {
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

export function normalizeRetry(input?: Partial<ScheduledTaskRetryPolicy>): ScheduledTaskRetryPolicy {
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

export function validateTimezone(timezone?: string): void {
	if (!timezone) return;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
	} catch {
		throw new Error(`Invalid IANA timezone: ${timezone}`);
	}
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
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

export function truncateLogValue(value: string | undefined, maxChars: number): string | undefined {
	if (!value || value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}\n… [truncated by Look]`;
}
