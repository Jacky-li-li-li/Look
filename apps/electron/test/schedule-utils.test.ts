import { describe, expect, it, vi } from "vitest";
import {
	buildScheduledTaskInput,
	createEmptyForm,
	effectiveChatId,
	formatTimeLeft,
	type ImBinding,
	localDateInput,
	maskAppId,
	p2pCandidatesFor,
	scheduleForTask,
} from "../src/renderer/components/scheduler/scheduleUtils";

const t = (key: string) => key;

function bindings(overrides: Partial<ImBinding>[] = []): ImBinding[] {
	const base: ImBinding = {
		chatId: "chat-1",
		sessionId: "session-1",
		projectId: "project-1",
		createdAt: 1,
		appId: "app-1",
		chatType: "p2p",
	};
	return overrides.map((o, i) => ({ ...base, chatId: `chat-${i + 1}`, createdAt: i + 1, ...o }));
}

describe("localDateInput", () => {
	it("formats a date as YYYY-MM-DD in local time", () => {
		const date = new Date(2024, 0, 5); // Jan 5 2024
		expect(localDateInput(date)).toBe("2024-01-05");
	});
});

describe("createEmptyForm", () => {
	it("defaults to a daily schedule at 09:00 with tomorrow's date preselected", () => {
		const form = createEmptyForm();
		expect(form.scheduleKind).toBe("daily");
		expect(form.time).toBe("09:00");
		const tomorrow = new Date();
		tomorrow.setDate(tomorrow.getDate() + 1);
		expect(form.onceDate).toBe(localDateInput(tomorrow));
		expect(form.maxAttempts).toBe("3");
		expect(form.initialDelaySeconds).toBe("5");
	});
});

describe("scheduleForTask", () => {
	const baseTask = {
		id: "t1",
		name: "Task",
		projectId: "p1",
		prompt: "do it",
		parameters: {},
		status: "scheduled" as const,
		retry: { maxAttempts: 3, initialDelayMs: 5000, backoffMultiplier: 2, maxDelayMs: 60000 },
		executionTimeoutMs: 1800000,
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
	};

	it("returns the structured schedule field when present", () => {
		const task = { ...baseTask, cron: "0 9 * * *", schedule: { kind: "daily" as const, time: "09:00" } };
		expect(scheduleForTask(task)).toEqual({ kind: "daily", time: "09:00" });
	});

	it("derives a daily schedule from a legacy cron expression", () => {
		const task = { ...baseTask, cron: "30 8 * * *" };
		expect(scheduleForTask(task)).toEqual({ kind: "daily", time: "08:30" });
	});

	it("derives a weekly schedule from a legacy cron expression with weekday", () => {
		const task = { ...baseTask, cron: "0 10 * * 1" };
		expect(scheduleForTask(task)).toEqual({ kind: "weekly", weekday: 1, time: "10:00" });
	});

	it("derives a monthly schedule from a legacy cron expression with day-of-month", () => {
		const task = { ...baseTask, cron: "0 9 15 * *" };
		expect(scheduleForTask(task)).toEqual({ kind: "monthly", day: 15, time: "09:00" });
	});
});

describe("formatTimeLeft", () => {
	it("returns an em dash when there is no next run", () => {
		expect(formatTimeLeft(undefined)).toBe("—");
	});

	it("returns 'due' for a time in the past", () => {
		expect(formatTimeLeft(new Date(Date.now() - 60_000).toISOString())).toBe("due");
	});

	it("formats minutes for near-term runs", () => {
		// formatTimeLeft 逐级 floor，且函数内部再次取 Date.now()。
		// 不留余量时两次取时必须落在同一毫秒才能通过（CI 上极易翻）；
		// +30s 余量让 floor 落在同一桶内。
		expect(formatTimeLeft(new Date(Date.now() + 5 * 60_000 + 30_000).toISOString())).toBe("5m");
	});

	it("formats hours and minutes", () => {
		expect(formatTimeLeft(new Date(Date.now() + 90 * 60_000 + 30_000).toISOString())).toBe("1h 30m");
	});

	it("formats days and hours", () => {
		expect(formatTimeLeft(new Date(Date.now() + 25 * 60 * 60_000 + 30 * 60_000).toISOString())).toBe("1d 1h");
	});
});

describe("maskAppId", () => {
	it("masks the middle of a long id", () => {
		expect(maskAppId("abcdefghijkl")).toBe("abcd****ijkl");
	});

	it("fully masks short ids", () => {
		expect(maskAppId("abc")).toBe("****");
	});
});

describe("p2pCandidatesFor", () => {
	it("filters to bindings for the given app id excluding group chats, newest first", () => {
		const list = bindings([
			{ appId: "app-1", chatType: "p2p", createdAt: 1 },
			{ appId: "app-2", chatType: "p2p", createdAt: 5 },
			{ appId: "app-1", chatType: "group", createdAt: 10 },
			{ appId: "app-1", chatType: "p2p", createdAt: 3 },
		]);
		const result = p2pCandidatesFor(list, "app-1");
		expect(result.map((b) => b.createdAt)).toEqual([3, 1]);
	});

	it("includes legacy bindings with no appId recorded", () => {
		const list = bindings([{ appId: undefined, chatType: "p2p", createdAt: 2 }]);
		expect(p2pCandidatesFor(list, "app-1")).toHaveLength(1);
	});
});

describe("effectiveChatId", () => {
	it("keeps the selected chat id when it is among the candidates", () => {
		const candidates = bindings([{ createdAt: 1 }, { createdAt: 2 }]);
		expect(effectiveChatId(candidates, "chat-2")).toBe("chat-2");
	});

	it("falls back to the first candidate when the selection is missing", () => {
		const candidates = bindings([{ createdAt: 1 }, { createdAt: 2 }]);
		expect(effectiveChatId(candidates, "chat-missing")).toBe("chat-1");
	});

	it("returns an empty string when there are no candidates", () => {
		expect(effectiveChatId([], "chat-1")).toBe("");
	});
});

describe("buildScheduledTaskInput", () => {
	function validForm() {
		return {
			...createEmptyForm(),
			name: "Daily digest",
			projectId: "project-1",
			prompt: "Summarize inbox",
			model: "openai/gpt-test",
			parameters: "{}",
		};
	}

	it("returns an error for malformed parameters JSON", () => {
		const result = buildScheduledTaskInput({ ...validForm(), parameters: "{not json" }, [], t);
		expect(result).toEqual({ error: "scheduledTasks.invalidParameters" });
	});

	it("returns an error when parameter values are not strings", () => {
		const result = buildScheduledTaskInput({ ...validForm(), parameters: '{"a":1}' }, [], t);
		expect(result).toEqual({ error: "scheduledTasks.invalidParameters" });
	});

	it("returns an error for a malformed time", () => {
		const result = buildScheduledTaskInput({ ...validForm(), time: "9am" }, [], t);
		expect(result).toEqual({ error: "scheduledTasks.invalidRunAt" });
	});

	it("returns an error when the name is blank", () => {
		const result = buildScheduledTaskInput({ ...validForm(), name: "   " }, [], t);
		expect(result).toEqual({ error: "scheduledTasks.nameRequired" });
	});

	it("returns an error when notifications are enabled without a resolvable chat target", () => {
		const result = buildScheduledTaskInput({ ...validForm(), notifyIm: true, notificationChannel: "app-1" }, [], t);
		expect(result).toEqual({ error: "scheduledTasks.notificationTargetRequired" });
	});

	it("returns an error for out-of-range retry settings", () => {
		const result = buildScheduledTaskInput({ ...validForm(), maxAttempts: "0" }, [], t);
		expect(result).toEqual({ error: "scheduledTasks.invalidRetry" });
	});

	it("builds a daily schedule input with retry and disabled notification by default", () => {
		const result = buildScheduledTaskInput(validForm(), [], t);
		expect("input" in result).toBe(true);
		if (!("input" in result)) throw new Error("expected input");
		expect(result.input.schedule).toEqual({ kind: "daily", time: "09:00" });
		expect(result.input.retry).toEqual({ maxAttempts: 3, initialDelayMs: 5_000 });
		expect(result.input.notification).toEqual({
			enabled: false,
			provider: "feishu",
			channelAppId: undefined,
			targetChatId: undefined,
		});
	});

	it("builds a once schedule input from onceDate and time", () => {
		const form = { ...validForm(), scheduleKind: "once" as const, onceDate: "2030-01-15", time: "14:30" };
		const result = buildScheduledTaskInput(form, [], t);
		if (!("input" in result)) throw new Error("expected input");
		expect(result.input.schedule.kind).toBe("once");
		if (result.input.schedule.kind === "once") {
			expect(new Date(result.input.schedule.runAt).toISOString().startsWith("2030-01-15")).toBe(true);
		}
	});

	it("resolves the notification target to the newest matching p2p binding", () => {
		const list = bindings([
			{ appId: "app-1", chatType: "p2p", createdAt: 1 },
			{ appId: "app-1", chatType: "p2p", createdAt: 9 },
		]);
		const form = { ...validForm(), notifyIm: true, notificationChannel: "app-1" };
		const result = buildScheduledTaskInput(form, list, t);
		if (!("input" in result)) throw new Error("expected input");
		expect(result.input.notification).toEqual({
			enabled: true,
			provider: "feishu",
			channelAppId: "app-1",
			targetChatId: "chat-2",
		});
	});
});

describe("t helper usage sanity", () => {
	it("does not call the translation function when no error occurs", () => {
		const spy = vi.fn((key: string) => key);
		const form = {
			...createEmptyForm(),
			name: "Task",
			projectId: "p1",
			prompt: "Do work",
			model: "openai/gpt-test",
		};
		buildScheduledTaskInput(form, [], spy);
		expect(spy).not.toHaveBeenCalled();
	});
});
