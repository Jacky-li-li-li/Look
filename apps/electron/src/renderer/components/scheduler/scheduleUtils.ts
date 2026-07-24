import type { ScheduledTask, ScheduledTaskInput, ScheduledTaskRunLog, ScheduledTaskSchedule } from "@shared/types";

export type ModelChoice = { provider: string; id: string; name: string };
export type ImChannel = { appId: string; name?: string; connected: boolean; enabled: boolean };
export type ImBinding = {
	chatId: string;
	sessionId: string;
	projectId: string;
	createdAt: number;
	appId?: string;
	chatType?: "p2p" | "group";
	peerName?: string;
};

export type FormState = {
	name: string;
	projectId: string;
	scheduleKind: ScheduledTaskSchedule["kind"];
	time: string;
	onceDate: string;
	weekday: string;
	monthDay: string;
	prompt: string;
	parameters: string;
	model: string;
	notifyIm: boolean;
	notificationChannel: string;
	notificationChatId: string;
	maxAttempts: string;
	initialDelaySeconds: string;
};

export function localDateInput(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function createEmptyForm(): FormState {
	const tomorrow = new Date();
	tomorrow.setDate(tomorrow.getDate() + 1);
	return {
		name: "",
		projectId: "",
		scheduleKind: "daily",
		time: "09:00",
		onceDate: localDateInput(tomorrow),
		weekday: "1",
		monthDay: "1",
		prompt: "",
		parameters: "{}",
		model: "",
		notifyIm: false,
		notificationChannel: "",
		notificationChatId: "",
		maxAttempts: "3",
		initialDelaySeconds: "5",
	};
}

export function scheduleForTask(task: ScheduledTask): ScheduledTaskSchedule {
	if (task.schedule) return task.schedule;
	const [minute = "0", hour = "9", day = "*", _month = "*", weekday = "*"] = task.cron.split(/\s+/);
	const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
	if (day !== "*") return { kind: "monthly", day: Number(day) || 1, time };
	if (weekday !== "*") return { kind: "weekly", weekday: Number(weekday) || 0, time };
	return { kind: "daily", time };
}

export function formatDate(value?: string): string {
	if (!value) return "—";
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function formatTimeLeft(nextRunAt?: string): string {
	if (!nextRunAt) return "—";
	const diff = new Date(nextRunAt).getTime() - Date.now();
	if (diff <= 0) return "due";
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	const days = Math.floor(hours / 24);
	return `${days}d ${hours % 24}h`;
}

export function statusDotColor(status: ScheduledTaskRunLog["status"]): string {
	if (status === "success") return "bg-emerald-400";
	if (status === "failed" || status === "interrupted") return "bg-destructive";
	if (status === "running" || status === "retrying") return "bg-amber-400";
	return "bg-muted-foreground/40";
}

export function statusBadgeStyle(status: ScheduledTaskRunLog["status"]): string {
	if (status === "success") return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
	if (status === "failed" || status === "interrupted") return "bg-destructive/10 text-destructive";
	if (status === "running" || status === "retrying") return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
	return "bg-muted-foreground/10 text-muted-foreground";
}

export function maskAppId(appId: string): string {
	if (appId.length <= 8) return "****";
	return `${appId.slice(0, 4)}****${appId.slice(-4)}`;
}

/** 指定渠道可推送的私聊会话候选（含 chatType 未回填的旧绑定），最新创建优先。 */
export function p2pCandidatesFor(imBindings: ImBinding[], appId: string): ImBinding[] {
	return imBindings
		.filter((b) => (!b.appId || b.appId === appId) && b.chatType !== "group")
		.sort((a, b) => b.createdAt - a.createdAt);
}

/** 选中的会话不在候选列表（如刚切换渠道）时回退到最新一条。 */
export function effectiveChatId(candidates: ImBinding[], selectedChatId: string): string {
	return candidates.some((b) => b.chatId === selectedChatId) ? selectedChatId : (candidates[0]?.chatId ?? "");
}

export type BuildScheduledTaskInputResult = { input: ScheduledTaskInput } | { error: string };

/**
 * 纯校验 + 构建函数：将表单状态转换为提交给主进程的 ScheduledTaskInput。
 * 不产生副作用（不 toast），失败时返回本地化后的错误文案供调用方展示。
 */
export function buildScheduledTaskInput(
	form: FormState,
	imBindings: ImBinding[],
	t: (key: string) => string,
): BuildScheduledTaskInputResult {
	let parameters: Record<string, string>;
	try {
		parameters = JSON.parse(form.parameters || "{}") as Record<string, string>;
		if (
			!parameters ||
			Array.isArray(parameters) ||
			typeof parameters !== "object" ||
			Object.values(parameters).some((value) => typeof value !== "string")
		)
			throw new Error();
	} catch {
		return { error: t("scheduledTasks.invalidParameters") };
	}
	if (!/^\d{2}:\d{2}$/.test(form.time)) {
		return { error: t("scheduledTasks.invalidRunAt") };
	}
	let schedule: ScheduledTaskSchedule;
	if (form.scheduleKind === "once") {
		const runAt = new Date(`${form.onceDate}T${form.time}:00`);
		if (Number.isNaN(runAt.getTime())) {
			return { error: t("scheduledTasks.invalidRunAt") };
		}
		schedule = { kind: "once", runAt: runAt.toISOString() };
	} else if (form.scheduleKind === "weekly") {
		const weekday = Number(form.weekday);
		if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
			return { error: t("scheduledTasks.invalidRunAt") };
		}
		schedule = { kind: "weekly", weekday, time: form.time };
	} else if (form.scheduleKind === "monthly") {
		const day = Number(form.monthDay);
		if (!Number.isInteger(day) || day < 1 || day > 31) {
			return { error: t("scheduledTasks.invalidRunAt") };
		}
		schedule = { kind: "monthly", day, time: form.time };
	} else {
		schedule = { kind: "daily", time: form.time };
	}
	if (!form.name.trim()) {
		return { error: t("scheduledTasks.nameRequired") };
	}
	if (!form.projectId) {
		return { error: t("scheduledTasks.projectRequired") };
	}
	if (!form.prompt.trim()) {
		return { error: t("scheduledTasks.promptRequired") };
	}
	if (!form.model) {
		return { error: t("scheduledTasks.modelRequired") };
	}
	const targetChatId = form.notifyIm
		? effectiveChatId(p2pCandidatesFor(imBindings, form.notificationChannel), form.notificationChatId)
		: "";
	if (form.notifyIm && (!form.notificationChannel || !targetChatId)) {
		return { error: t("scheduledTasks.notificationTargetRequired") };
	}
	const maxAttempts = Number(form.maxAttempts);
	const initialDelaySeconds = Number(form.initialDelaySeconds);
	if (
		!Number.isInteger(maxAttempts) ||
		maxAttempts < 1 ||
		maxAttempts > 20 ||
		!Number.isFinite(initialDelaySeconds) ||
		initialDelaySeconds < 0
	) {
		return { error: t("scheduledTasks.invalidRetry") };
	}
	return {
		input: {
			name: form.name,
			projectId: form.projectId,
			schedule,
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			prompt: form.prompt,
			parameters,
			model: form.model,
			notification: {
				enabled: form.notifyIm,
				provider: "feishu",
				channelAppId: form.notificationChannel || undefined,
				targetChatId: targetChatId || undefined,
			},
			retry: {
				maxAttempts,
				initialDelayMs: initialDelaySeconds * 1_000,
			},
		},
	};
}
