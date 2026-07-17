import { Badge } from "@shared/components/ui/badge";
import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import { Label } from "@shared/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@shared/components/ui/select";
import { Switch } from "@shared/components/ui/switch";
import { Textarea } from "@shared/components/ui/textarea";
import { cn } from "@shared/lib/utils";
import type {
	ProjectInfo,
	ScheduledTask,
	ScheduledTaskInput,
	ScheduledTaskRunLog,
	ScheduledTaskSchedule,
} from "@shared/types";
import { useSetAtom } from "jotai";
import {
	AlertCircle,
	ArrowLeft,
	BellRing,
	CalendarDays,
	CheckCircle2,
	CirclePause,
	CirclePlay,
	Clock3,
	ExternalLink,
	FlaskConical,
	LoaderCircle,
	Pencil,
	Play,
	Plus,
	RotateCw,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { activeAgentIdAtom, showScheduledTasksAtom } from "../../store/atoms";

type ModelChoice = { provider: string; id: string; name: string };
type ImChannel = { appId: string; name?: string; connected: boolean; enabled: boolean };
type ImBinding = { chatId: string; sessionId: string; projectId: string; createdAt: number; appId?: string };

type FormState = {
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
	maxAttempts: string;
	initialDelaySeconds: string;
};

function localDateInput(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function createEmptyForm(): FormState {
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
		maxAttempts: "3",
		initialDelaySeconds: "5",
	};
}

function scheduleForTask(task: ScheduledTask): ScheduledTaskSchedule {
	if (task.schedule) return task.schedule;
	const [minute = "0", hour = "9", day = "*", _month = "*", weekday = "*"] = task.cron.split(/\s+/);
	const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
	if (day !== "*") return { kind: "monthly", day: Number(day) || 1, time };
	if (weekday !== "*") return { kind: "weekly", weekday: Number(weekday) || 0, time };
	return { kind: "daily", time };
}

function formatDate(value?: string): string {
	if (!value) return "—";
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatTimeLeft(nextRunAt?: string): string {
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

function statusDotColor(status: ScheduledTaskRunLog["status"]): string {
	if (status === "success") return "bg-emerald-400";
	if (status === "failed" || status === "interrupted") return "bg-destructive";
	if (status === "running" || status === "retrying") return "bg-amber-400";
	return "bg-muted-foreground/40";
}

function statusBadgeStyle(status: ScheduledTaskRunLog["status"]): string {
	if (status === "success") return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
	if (status === "failed" || status === "interrupted") return "bg-destructive/10 text-destructive";
	if (status === "running" || status === "retrying") return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
	return "bg-muted-foreground/10 text-muted-foreground";
}

function maskAppId(appId: string): string {
	if (appId.length <= 8) return "****";
	return `${appId.slice(0, 4)}****${appId.slice(-4)}`;
}

function EmptyTaskList() {
	const { t } = useTranslation();
	return (
		<div className="flex h-full flex-col items-center justify-center px-6 text-center">
			<div className="flex size-10 items-center justify-center rounded-full border border-dashed border-hairline bg-background">
				<Clock3 className="size-4 text-muted-foreground" />
			</div>
			<p className="mt-3 text-xs font-medium">{t("scheduledTasks.empty")}</p>
			<p className="mt-1 text-[11px] text-muted-foreground">{t("scheduledTasks.emptyHint")}</p>
		</div>
	);
}

function EmptyWorkspace() {
	const { t } = useTranslation();
	return (
		<div className="flex h-full flex-col items-center justify-center px-6 text-center">
			<div className="flex size-12 items-center justify-center rounded-full border border-dashed border-hairline bg-muted/30">
				<CalendarDays className="size-5 text-muted-foreground" />
			</div>
			<p className="mt-4 text-sm font-medium">{t("scheduledTasks.noSelection")}</p>
			<p className="mt-1 max-w-xs text-[11px] text-muted-foreground">{t("scheduledTasks.noSelectionHint")}</p>
		</div>
	);
}

type TaskListItemProps = {
	task: ScheduledTask;
	selectedId: string | null;
	projects: ProjectInfo[];
	describeSchedule: (task: ScheduledTask) => string;
	selectTask: (task: ScheduledTask) => void;
};

function TaskListItem({ task, selectedId, projects, describeSchedule, selectTask }: TaskListItemProps) {
	const { t } = useTranslation();
	const isSelected = selectedId === task.id;
	const projectName = projects.find((p) => p.id === task.projectId)?.name ?? task.projectId;
	return (
		<div
			role="button"
			aria-label={task.name}
			tabIndex={0}
			onClick={() => selectTask(task)}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") selectTask(task);
			}}
			className={`group flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 ${isSelected ? "border-foreground/25 bg-accent/30" : "border-hairline bg-background hover:bg-accent/15"}`}
		>
			<div className="flex shrink-0 flex-col items-center gap-1">
				<span
					className={`size-2 rounded-full ${task.status === "scheduled" ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
				/>
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-xs font-medium">{task.name}</span>
					<Badge variant="secondary" className="h-4 px-1.5 text-[9px]">
						{task.status === "scheduled" ? t("scheduledTasks.active") : t("scheduledTasks.paused")}
					</Badge>
				</div>
				<p className="mt-0.5 truncate text-[10px] text-muted-foreground">{describeSchedule(task)}</p>
				<div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
					<span className="truncate">{projectName}</span>
					{task.model && <span className="text-hairline">·</span>}
					{task.model && <span className="font-mono truncate">{task.model}</span>}
				</div>
			</div>
			<div className="flex shrink-0 flex-col items-end gap-1">
				<span className="font-mono text-[10px] text-muted-foreground">{formatTimeLeft(task.nextRunAt)}</span>
				{task.notification?.enabled && <BellRing className="size-3 text-muted-foreground" />}
			</div>
		</div>
	);
}

type TaskDetailProps = {
	task: ScheduledTask;
	projects: ProjectInfo[];
	imChannels: ImChannel[];
	describeSchedule: (task: ScheduledTask) => string;
	busy: boolean;
	openEdit: (task: ScheduledTask) => void;
	act: (action: "start" | "pause" | "run" | "delete", task: ScheduledTask) => void;
};

function TaskDetail({ task, projects, imChannels, describeSchedule, busy, openEdit, act }: TaskDetailProps) {
	const { t } = useTranslation();
	const projectName = projects.find((p) => p.id === task.projectId)?.name ?? task.projectId;
	const notificationTarget = (() => {
		const notification = task.notification;
		if (!notification?.enabled) return null;
		if (notification.channelAppId) {
			const channel = imChannels.find((c) => c.appId === notification.channelAppId);
			return `${channel?.name || maskAppId(notification.channelAppId)} · ${t("scheduledTasks.imPrivateChat")}`;
		}
		// Legacy target: a raw chatId.
		return notification.targetChatId ? `…${notification.targetChatId.slice(-8)}` : null;
	})();
	return (
		<div className="mx-auto max-w-3xl space-y-6">
			<div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2.5">
						<h2 className="truncate text-lg font-semibold tracking-tight">{task.name}</h2>
						<Badge
							variant={task.status === "scheduled" ? "default" : "secondary"}
							className="shrink-0 text-[10px]"
						>
							{task.status === "scheduled" ? t("scheduledTasks.active") : t("scheduledTasks.paused")}
						</Badge>
					</div>
					<p className="mt-1 truncate text-[11px] text-muted-foreground">
						{t("scheduledTasks.project")}: {projectName}
					</p>
				</div>
				<div className="flex shrink-0 flex-wrap gap-1">
					<Button variant="outline" size="sm" onClick={() => openEdit(task)}>
						<Pencil className="size-3.5" />
						<span className="hidden sm:inline">{t("scheduledTasks.edit")}</span>
					</Button>
					<Button variant="outline" size="sm" onClick={() => void act("run", task)} disabled={busy}>
						<Play className="size-3.5" />
						<span className="hidden sm:inline">{t("scheduledTasks.runNow")}</span>
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={() => void act(task.status === "scheduled" ? "pause" : "start", task)}
						disabled={busy}
					>
						{task.status === "scheduled" ? (
							<CirclePause className="size-3.5" />
						) : (
							<CirclePlay className="size-3.5" />
						)}
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={t("common.delete")}
						onClick={() => void act("delete", task)}
						disabled={busy}
					>
						<Trash2 className="size-4 text-destructive" />
					</Button>
				</div>
			</div>

			<div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 rounded-lg border border-hairline bg-muted/15 px-4 py-3">
				<div className="min-w-0">
					<span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
						{t("scheduledTasks.frequency")}
					</span>
					<p className="mt-0.5 truncate text-[13px] font-medium">{describeSchedule(task)}</p>
				</div>
				<div className="min-w-0">
					<span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
						{t("scheduledTasks.next")}
					</span>
					<p className="mt-0.5 truncate text-[13px] font-medium">{formatDate(task.nextRunAt)}</p>
					<p className="font-mono text-[10px] text-muted-foreground">{formatTimeLeft(task.nextRunAt)}</p>
				</div>
				<div className="min-w-0">
					<span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
						{t("scheduledTasks.model")}
					</span>
					<p className="mt-0.5 truncate font-mono text-[13px] font-medium">{task.model ?? "—"}</p>
				</div>
				<div className="min-w-0">
					<span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
						{t("scheduledTasks.attempts")}
					</span>
					<p className="mt-0.5 text-[13px] font-medium">
						{task.retry.maxAttempts} / {task.retry.initialDelayMs / 1_000}s
					</p>
				</div>
			</div>

			<div className="space-y-4">
				<div>
					<h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
						{t("scheduledTasks.prompt")}
					</h3>
					<div className="max-h-48 overflow-y-auto rounded-lg border border-hairline bg-muted/15 p-3">
						<p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed">{task.prompt}</p>
					</div>
				</div>

				{Object.keys(task.parameters).length > 0 && (
					<div>
						<h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
							{t("scheduledTasks.parameters")}
						</h3>
						<div className="max-h-40 overflow-auto rounded-lg border border-hairline bg-muted/15 p-3">
							<pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
								{JSON.stringify(task.parameters, null, 2)}
							</pre>
						</div>
					</div>
				)}
			</div>

			{notificationTarget && (
				<div className="flex items-center gap-2 rounded-lg border border-hairline bg-muted/15 px-3 py-2">
					<BellRing className="size-3.5 shrink-0 text-muted-foreground" />
					<span className="truncate text-[11px] text-muted-foreground">
						{t("scheduledTasks.imEnabled")} · {notificationTarget}
					</span>
				</div>
			)}
		</div>
	);
}

type TaskEditorProps = {
	editingId: string | null;
	form: FormState;
	setForm: React.Dispatch<React.SetStateAction<FormState>>;
	projects: ProjectInfo[];
	models: ModelChoice[];
	imChannels: ImChannel[];
	busy: boolean;
	testing: boolean;
	testResult: ScheduledTaskRunLog | null;
	closeEditor: () => void;
	save: () => Promise<void>;
	testTask: () => Promise<void>;
};

function Field({
	id,
	label,
	children,
	className,
}: {
	id: string;
	label: string;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("space-y-1.5", className)}>
			<Label htmlFor={id} className="text-[11px] font-medium text-muted-foreground">
				{label}
			</Label>
			{children}
		</div>
	);
}

function TaskEditor({
	editingId,
	form,
	setForm,
	projects,
	models,
	imChannels,
	busy,
	testing,
	testResult,
	closeEditor,
	save,
	testTask,
}: TaskEditorProps) {
	const { t } = useTranslation();
	const id = useId();

	const handleNameChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => setForm((prev) => ({ ...prev, name: e.target.value })),
		[setForm],
	);
	const handleProjectChange = useCallback(
		(projectId: string) => setForm((prev) => ({ ...prev, projectId })),
		[setForm],
	);
	const handleScheduleKindChange = useCallback(
		(scheduleKind: string) =>
			setForm((prev) => ({ ...prev, scheduleKind: scheduleKind as ScheduledTaskSchedule["kind"] })),
		[setForm],
	);
	const handleOnceDateChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => setForm((prev) => ({ ...prev, onceDate: e.target.value })),
		[setForm],
	);
	const handleWeekdayChange = useCallback((weekday: string) => setForm((prev) => ({ ...prev, weekday })), [setForm]);
	const handleMonthDayChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => setForm((prev) => ({ ...prev, monthDay: e.target.value })),
		[setForm],
	);
	const handleTimeChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => setForm((prev) => ({ ...prev, time: e.target.value })),
		[setForm],
	);
	const handleModelChange = useCallback((model: string) => setForm((prev) => ({ ...prev, model })), [setForm]);
	const handleNotifyImChange = useCallback(
		(notifyIm: boolean) => setForm((prev) => ({ ...prev, notifyIm })),
		[setForm],
	);
	const handleNotificationChannelChange = useCallback(
		(notificationChannel: string) => setForm((prev) => ({ ...prev, notificationChannel })),
		[setForm],
	);
	const handlePromptChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => setForm((prev) => ({ ...prev, prompt: e.target.value })),
		[setForm],
	);
	const handleParametersChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => setForm((prev) => ({ ...prev, parameters: e.target.value })),
		[setForm],
	);
	const handleMaxAttemptsChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => setForm((prev) => ({ ...prev, maxAttempts: e.target.value })),
		[setForm],
	);
	const handleInitialDelayChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => setForm((prev) => ({ ...prev, initialDelaySeconds: e.target.value })),
		[setForm],
	);

	const imDisabled = !form.notifyIm && imChannels.length === 0;

	return (
		<div className="mx-auto max-w-3xl space-y-6">
			<div className="flex items-center justify-between gap-4">
				<h2 className="text-lg font-semibold tracking-tight">
					{editingId ? t("scheduledTasks.edit") : t("scheduledTasks.newTask")}
				</h2>
				<Button variant="ghost" size="sm" onClick={closeEditor}>
					<X className="size-3.5" />
					{t("common.cancel")}
				</Button>
			</div>

			<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
				<Field id={`${id}-name`} label={t("scheduledTasks.name")}>
					<Input id={`${id}-name`} value={form.name} onChange={handleNameChange} autoComplete="off" />
				</Field>
				<Field id={`${id}-project`} label={t("scheduledTasks.project")}>
					<Select value={form.projectId} onValueChange={handleProjectChange}>
						<SelectTrigger id={`${id}-project`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{projects.map((project) => (
								<SelectItem key={project.id} value={project.id}>
									{project.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
			</div>

			<div className="rounded-lg border border-hairline bg-muted/15 p-4 pl-3.5 border-l-4 border-l-primary/30">
				<div className="mb-3 flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
					<CalendarDays className="size-3.5" />
					{t("scheduledTasks.executionPlan")}
				</div>

				<div className="flex flex-wrap items-end gap-3">
					<div className="min-w-0 flex-1" style={{ flexBasis: 120 }}>
						<Field id={`${id}-frequency`} label={t("scheduledTasks.frequency")}>
							<Select value={form.scheduleKind} onValueChange={handleScheduleKindChange}>
								<SelectTrigger id={`${id}-frequency`}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="once">{t("scheduledTasks.once")}</SelectItem>
									<SelectItem value="daily">{t("scheduledTasks.daily")}</SelectItem>
									<SelectItem value="weekly">{t("scheduledTasks.weekly")}</SelectItem>
									<SelectItem value="monthly">{t("scheduledTasks.monthly")}</SelectItem>
								</SelectContent>
							</Select>
						</Field>
					</div>
					{form.scheduleKind === "once" && (
						<div className="min-w-0 flex-1" style={{ flexBasis: 140 }}>
							<Field id={`${id}-once-date`} label={t("scheduledTasks.runDate")}>
								<Input
									id={`${id}-once-date`}
									type="date"
									value={form.onceDate}
									onChange={handleOnceDateChange}
								/>
							</Field>
						</div>
					)}
					{form.scheduleKind === "weekly" && (
						<div className="min-w-0 flex-1" style={{ flexBasis: 140 }}>
							<Field id={`${id}-weekday`} label={t("scheduledTasks.weekday")}>
								<Select value={form.weekday} onValueChange={handleWeekdayChange}>
									<SelectTrigger id={`${id}-weekday`}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{[1, 2, 3, 4, 5, 6, 0].map((day) => (
											<SelectItem key={day} value={String(day)}>
												{t(`scheduledTasks.weekday${day}`)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</Field>
						</div>
					)}
					{form.scheduleKind === "monthly" && (
						<div className="min-w-0" style={{ width: 100 }}>
							<Field id={`${id}-month-day`} label={t("scheduledTasks.monthDay")}>
								<Input
									id={`${id}-month-day`}
									type="number"
									min="1"
									max="31"
									value={form.monthDay}
									onChange={handleMonthDayChange}
								/>
							</Field>
						</div>
					)}
					<div className="min-w-0 flex-1" style={{ flexBasis: 120 }}>
						<Field id={`${id}-time`} label={t("scheduledTasks.runTime")}>
							<Input id={`${id}-time`} type="time" value={form.time} onChange={handleTimeChange} />
						</Field>
					</div>
				</div>

				<div className="mt-4 border-t border-hairline pt-3">
					<div className="flex flex-wrap items-end gap-3">
						<div className="min-w-0 flex-1" style={{ flexBasis: 100 }}>
							<Field id={`${id}-max-attempts`} label={t("scheduledTasks.attempts")}>
								<Input
									id={`${id}-max-attempts`}
									type="number"
									min="1"
									max="20"
									value={form.maxAttempts}
									onChange={handleMaxAttemptsChange}
								/>
							</Field>
						</div>
						<div className="min-w-0 flex-1" style={{ flexBasis: 110 }}>
							<Field id={`${id}-retry-delay`} label={t("scheduledTasks.retryDelay")}>
								<Input
									id={`${id}-retry-delay`}
									type="number"
									min="0"
									value={form.initialDelaySeconds}
									onChange={handleInitialDelayChange}
								/>
							</Field>
						</div>
					</div>
				</div>

				<p className="mt-3 text-[10px] text-muted-foreground">
					{t("scheduledTasks.localTimezone", {
						timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
					})}
				</p>
			</div>

			<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
				<Field id={`${id}-model`} label={t("scheduledTasks.model")}>
					<Select value={form.model} onValueChange={handleModelChange}>
						<SelectTrigger id={`${id}-model`}>
							<SelectValue placeholder={t("scheduledTasks.selectModel")} />
						</SelectTrigger>
						<SelectContent>
							{models.map((model) => (
								<SelectItem key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
									{model.name} · {model.provider}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>

				<div className="rounded-lg border border-hairline bg-muted/15 p-3">
					<div className="flex items-start justify-between gap-3">
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<BellRing className="size-3.5 text-muted-foreground" />
								<Label htmlFor={`${id}-notify-im`} className="text-[11px]">
									{t("scheduledTasks.imNotification")}
								</Label>
							</div>
							<p className="mt-0.5 text-[10px] text-muted-foreground">
								{t("scheduledTasks.imNotificationDesc")}
							</p>
						</div>
						<Switch
							id={`${id}-notify-im`}
							size="sm"
							checked={form.notifyIm}
							disabled={imDisabled}
							onCheckedChange={handleNotifyImChange}
						/>
					</div>
					{form.notifyIm && (
						<>
							<Select value={form.notificationChannel} onValueChange={handleNotificationChannelChange}>
								<SelectTrigger className="mt-2">
									<SelectValue placeholder={t("scheduledTasks.selectNotificationTarget")} />
								</SelectTrigger>
								<SelectContent>
									{imChannels.map((channel) => (
										<SelectItem key={channel.appId} value={channel.appId}>
											{channel.name || maskAppId(channel.appId)}
											{channel.connected ? "" : ` · ${t("scheduledTasks.imDisconnected")}`}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="mt-2 text-[10px] text-muted-foreground">{t("scheduledTasks.imP2pHint")}</p>
						</>
					)}
					{imChannels.length === 0 && (
						<p className="mt-2 text-[10px] text-amber-600 dark:text-amber-400">
							{t("scheduledTasks.imUnavailable")}
						</p>
					)}
				</div>
			</div>

			<div className="space-y-4">
				<Field id={`${id}-prompt`} label={t("scheduledTasks.prompt")}>
					<Textarea
						id={`${id}-prompt`}
						className="min-h-32 resize-y"
						value={form.prompt}
						onChange={handlePromptChange}
						placeholder={t("scheduledTasks.promptPlaceholder")}
					/>
				</Field>
				<Field id={`${id}-parameters`} label={t("scheduledTasks.parameters")}>
					<Textarea
						id={`${id}-parameters`}
						className="min-h-24 resize-y font-mono text-[11px]"
						value={form.parameters}
						onChange={handleParametersChange}
					/>
				</Field>
			</div>

			{testResult && (
				<div
					className={cn(
						"rounded-lg border px-3 py-2.5",
						testResult.status === "success"
							? "border-emerald-500/30 bg-emerald-500/5"
							: "border-destructive/30 bg-destructive/5",
					)}
				>
					<div className="flex items-center gap-2 text-[11px] font-medium">
						{testResult.status === "success" ? (
							<CheckCircle2 className="size-3.5 text-emerald-600" />
						) : (
							<AlertCircle className="size-3.5 text-destructive" />
						)}
						{testResult.status === "success" ? t("scheduledTasks.testSuccess") : t("scheduledTasks.testFailed")}
					</div>
					{(testResult.output || testResult.errorMessage) && (
						<p className="mt-1.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed text-muted-foreground">
							{testResult.output || testResult.errorMessage}
						</p>
					)}
					{testResult.notificationStatus && (
						<p className="mt-1 text-[9px] text-muted-foreground">
							{testResult.notificationStatus === "sent"
								? t("scheduledTasks.notificationSent")
								: t("scheduledTasks.notificationFailed", { error: testResult.notificationError })}
						</p>
					)}
				</div>
			)}

			<div className="flex items-center justify-between gap-3 pt-2">
				<Button variant="outline" size="sm" disabled={busy || testing} onClick={() => void testTask()}>
					{testing ? <LoaderCircle className="size-3.5 animate-spin" /> : <FlaskConical className="size-3.5" />}
					{testing ? t("scheduledTasks.testingTask") : t("scheduledTasks.testTask")}
				</Button>
				<div className="flex items-center gap-2">
					<Button variant="ghost" size="sm" disabled={testing} onClick={closeEditor}>
						{t("common.cancel")}
					</Button>
					<Button size="sm" disabled={busy || testing} onClick={() => void save()}>
						{t("common.save")}
					</Button>
				</div>
			</div>
		</div>
	);
}

type ExecutionHistoryProps = {
	logs: ScheduledTaskRunLog[];
	selected: ScheduledTask | null;
	navigateToSession: (sessionId: string) => void;
};

function ExecutionHistory({ logs, selected, navigateToSession }: ExecutionHistoryProps) {
	const { t } = useTranslation();
	if (logs.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center py-16 text-center">
				<Clock3 className="size-5 text-muted-foreground/30" />
				<p className="mt-2 text-[11px] text-muted-foreground">{t("scheduledTasks.noRuns")}</p>
			</div>
		);
	}
	return (
		<div className="relative">
			<div className="absolute left-[6px] top-2 bottom-2 w-px bg-border" />
			{logs.map((log) => (
				<div key={log.id} className="group relative pb-5 last:pb-0">
					<span
						className={cn(
							"absolute left-0 top-1.5 z-10 size-3 rounded-full border-2 border-background transition-shadow",
							statusDotColor(log.status),
							"group-hover:shadow-[0_0_0_3px_var(--tw-shadow-color)] group-hover:shadow-current/20",
						)}
					/>
					<div className="ml-6 rounded-lg px-3 py-2 transition-colors group-hover:bg-accent/40">
						<div className="flex items-center justify-between gap-3">
							<div className="flex min-w-0 items-center gap-2">
								<span
									className={cn(
										"shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
										statusBadgeStyle(log.status),
									)}
								>
									{log.status}
								</span>
								{log.attempt > 1 && (
									<span className="text-[10px] text-muted-foreground">
										{t("scheduledTasks.attemptLabel", { attempt: log.attempt, max: log.maxAttempts })}
									</span>
								)}
							</div>
							<span className="shrink-0 font-mono text-[10px] text-muted-foreground/50">
								{formatDate(log.startedAt)}
							</span>
						</div>
						{log.errorMessage && (
							<div className="mt-2 flex items-start gap-1.5 rounded-lg bg-destructive/5 px-2.5 py-2">
								<AlertCircle className="mt-0.5 size-3 shrink-0 text-destructive" />
								<p className="text-[10px] leading-relaxed text-destructive/80">{log.errorMessage}</p>
							</div>
						)}
						{log.sessionId && log.status === "success" && (
							<button
								type="button"
								className="mt-1.5 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
								onClick={() => log.sessionId && navigateToSession(log.sessionId)}
							>
								{log.taskName}
								<ExternalLink className="size-3" />
							</button>
						)}
						{log.sessionId && log.status !== "success" && (
							<p className="mt-1.5 text-[11px] text-muted-foreground/50">{log.taskName}</p>
						)}
						{!log.sessionId && log.output && (
							<p className="mt-1.5 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
								{log.output}
							</p>
						)}
						{log.notificationStatus && (
							<p
								className={cn(
									"mt-1.5 text-[10px]",
									log.notificationStatus === "failed" ? "text-destructive/70" : "text-muted-foreground",
								)}
							>
								{log.notificationStatus === "sent"
									? t("scheduledTasks.notificationSent")
									: t("scheduledTasks.notificationFailed", { error: log.notificationError })}
							</p>
						)}
					</div>
				</div>
			))}
		</div>
	);
}

export default function ScheduledTasksPage() {
	const { t } = useTranslation();
	const setShowScheduledTasks = useSetAtom(showScheduledTasksAtom);
	const setActiveAgentId = useSetAtom(activeAgentIdAtom);
	const [tasks, setTasks] = useState<ScheduledTask[]>([]);
	const [projects, setProjects] = useState<ProjectInfo[]>([]);
	const [models, setModels] = useState<ModelChoice[]>([]);
	const [imChannels, setImChannels] = useState<ImChannel[]>([]);
	const [imBindings, setImBindings] = useState<ImBinding[]>([]);
	const [logs, setLogs] = useState<ScheduledTaskRunLog[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [form, setForm] = useState<FormState>(createEmptyForm);
	const [showEditor, setShowEditor] = useState(false);
	const [busy, setBusy] = useState(false);
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<ScheduledTaskRunLog | null>(null);
	const [activeTab, setActiveTab] = useState<"detail" | "history">("detail");

	const selected = useMemo(() => tasks.find((task) => task.id === selectedId) ?? null, [tasks, selectedId]);
	const activeCount = useMemo(() => tasks.filter((t) => t.status === "scheduled").length, [tasks]);
	const pausedCount = tasks.length - activeCount;

	const describeSchedule = useCallback(
		(task: ScheduledTask): string => {
			const schedule = scheduleForTask(task);
			if (schedule.kind === "once") return t("scheduledTasks.onceAt", { date: formatDate(schedule.runAt) });
			if (schedule.kind === "daily") return t("scheduledTasks.dailyAt", { time: schedule.time });
			if (schedule.kind === "weekly") {
				return t("scheduledTasks.weeklyAt", {
					weekday: t(`scheduledTasks.weekday${schedule.weekday}`),
					time: schedule.time,
				});
			}
			return t("scheduledTasks.monthlyAt", { day: schedule.day, time: schedule.time });
		},
		[t],
	);

	const refresh = useCallback(async () => {
		const [taskResult, projectResult, modelResult, bindingResult, channelResult] = await Promise.all([
			window.look.listScheduledTasks(),
			window.look.listProjects(),
			window.look.getModels(),
			window.look.getImBindings(),
			window.look.getImChannels(),
		]);
		if (taskResult.success) setTasks(taskResult.tasks);
		const nextModels = modelResult.success ? modelResult.models : [];
		const nextChannels = channelResult.success ? (channelResult.channels ?? []) : [];
		setModels(nextModels);
		setImChannels(nextChannels);
		setImBindings(bindingResult.success ? (bindingResult.bindings ?? []) : []);
		if (projectResult.success) {
			setProjects(projectResult.projects);
			setForm((current) => ({
				...current,
				projectId: current.projectId || projectResult.projects[0]?.id || "",
				model: current.model || (nextModels[0] ? `${nextModels[0].provider}/${nextModels[0].id}` : ""),
				notificationChannel: current.notificationChannel || nextChannels[0]?.appId || "",
			}));
		}
	}, []);

	const refreshLogs = useCallback(async (taskId?: string) => {
		const result = await window.look.listScheduledTaskLogs(taskId, 40);
		if (result.success) setLogs(result.logs);
	}, []);

	useEffect(() => {
		void refresh();
		void refreshLogs();
	}, [refresh, refreshLogs]);

	useEffect(() => {
		void refreshLogs(selectedId ?? undefined);
	}, [selectedId, refreshLogs]);

	const openCreate = () => {
		setTestResult(null);
		setEditingId(null);
		setForm({
			...createEmptyForm(),
			projectId: projects[0]?.id ?? "",
			model: models[0] ? `${models[0].provider}/${models[0].id}` : "",
			notificationChannel: imChannels[0]?.appId ?? "",
		});
		setSelectedId(null);
		setShowEditor(true);
	};

	const openEdit = (task: ScheduledTask) => {
		setTestResult(null);
		const schedule = scheduleForTask(task);
		const runAt = schedule.kind === "once" ? new Date(schedule.runAt) : null;
		// Channel-based notifications prefill directly; legacy chatId targets are
		// mapped back to their channel via the binding metadata when possible.
		const legacyChannel = task.notification?.targetChatId
			? imBindings.find((binding) => binding.chatId === task.notification?.targetChatId)?.appId
			: undefined;
		setEditingId(task.id);
		setForm({
			name: task.name,
			projectId: task.projectId,
			scheduleKind: schedule.kind,
			time:
				schedule.kind === "once"
					? `${String(runAt?.getHours() ?? 9).padStart(2, "0")}:${String(runAt?.getMinutes() ?? 0).padStart(2, "0")}`
					: schedule.time,
			onceDate: runAt ? localDateInput(runAt) : createEmptyForm().onceDate,
			weekday: schedule.kind === "weekly" ? String(schedule.weekday) : "1",
			monthDay: schedule.kind === "monthly" ? String(schedule.day) : "1",
			prompt: task.prompt,
			parameters: JSON.stringify(task.parameters, null, 2),
			model: task.model ?? "",
			notifyIm: task.notification?.enabled ?? false,
			notificationChannel: task.notification?.channelAppId ?? legacyChannel ?? imChannels[0]?.appId ?? "",
			maxAttempts: String(task.retry.maxAttempts),
			initialDelaySeconds: String(task.retry.initialDelayMs / 1_000),
		});
		setSelectedId(task.id);
		setShowEditor(true);
	};

	const closeEditor = () => {
		setShowEditor(false);
		setEditingId(null);
		setTestResult(null);
	};

	const updateForm: React.Dispatch<React.SetStateAction<FormState>> = useCallback((update) => {
		setTestResult(null);
		setForm(update);
	}, []);

	const buildInput = (): ScheduledTaskInput | null => {
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
			toast.error(t("scheduledTasks.invalidParameters"));
			return null;
		}
		if (!/^\d{2}:\d{2}$/.test(form.time)) {
			toast.error(t("scheduledTasks.invalidRunAt"));
			return null;
		}
		let schedule: ScheduledTaskSchedule;
		if (form.scheduleKind === "once") {
			const runAt = new Date(`${form.onceDate}T${form.time}:00`);
			if (Number.isNaN(runAt.getTime())) {
				toast.error(t("scheduledTasks.invalidRunAt"));
				return null;
			}
			schedule = { kind: "once", runAt: runAt.toISOString() };
		} else if (form.scheduleKind === "weekly") {
			const weekday = Number(form.weekday);
			if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
				toast.error(t("scheduledTasks.invalidRunAt"));
				return null;
			}
			schedule = { kind: "weekly", weekday, time: form.time };
		} else if (form.scheduleKind === "monthly") {
			const day = Number(form.monthDay);
			if (!Number.isInteger(day) || day < 1 || day > 31) {
				toast.error(t("scheduledTasks.invalidRunAt"));
				return null;
			}
			schedule = { kind: "monthly", day, time: form.time };
		} else {
			schedule = { kind: "daily", time: form.time };
		}
		if (!form.name.trim()) {
			toast.error(t("scheduledTasks.nameRequired"));
			return null;
		}
		if (!form.projectId) {
			toast.error(t("scheduledTasks.projectRequired"));
			return null;
		}
		if (!form.prompt.trim()) {
			toast.error(t("scheduledTasks.promptRequired"));
			return null;
		}
		if (!form.model) {
			toast.error(t("scheduledTasks.modelRequired"));
			return null;
		}
		if (form.notifyIm && !form.notificationChannel) {
			toast.error(t("scheduledTasks.notificationTargetRequired"));
			return null;
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
			toast.error(t("scheduledTasks.invalidRetry"));
			return null;
		}
		return {
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
			},
			retry: {
				maxAttempts,
				initialDelayMs: initialDelaySeconds * 1_000,
			},
		};
	};

	const save = async () => {
		const input = buildInput();
		if (!input) return;
		setBusy(true);
		try {
			const result = editingId
				? await window.look.updateScheduledTask(editingId, input)
				: await window.look.createScheduledTask(input);
			if (!result.success) throw new Error(result.error);
			toast.success(editingId ? t("scheduledTasks.updated") : t("scheduledTasks.created"));
			closeEditor();
			await refresh();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const testTask = async () => {
		const input = buildInput();
		if (!input) return;
		setTesting(true);
		setTestResult(null);
		try {
			const result = await window.look.testScheduledTask(input, editingId ?? undefined);
			if (!result.success) throw new Error(result.error);
			setTestResult(result.log);
			if (result.log.status === "success") toast.success(t("scheduledTasks.testSuccess"));
			else toast.error(result.log.errorMessage || t("scheduledTasks.testFailed"));
			await refreshLogs(selectedId ?? undefined);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			setTesting(false);
		}
	};

	const act = async (action: "start" | "pause" | "run" | "delete", task: ScheduledTask) => {
		if (action === "delete" && !window.confirm(t("scheduledTasks.deleteConfirm", { name: task.name }))) return;
		setBusy(true);
		try {
			const result =
				action === "start"
					? await window.look.startScheduledTask(task.id)
					: action === "pause"
						? await window.look.pauseScheduledTask(task.id)
						: action === "run"
							? await window.look.runScheduledTaskNow(task.id)
							: await window.look.deleteScheduledTask(task.id);
			if (!result.success) throw new Error(result.error);
			if (action === "run") toast.success(t("scheduledTasks.runAccepted"));
			if (action === "delete" && selectedId === task.id) {
				setSelectedId(null);
				setEditingId(null);
				setShowEditor(false);
			}
			await refresh();
			await refreshLogs(selectedId ?? undefined);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const selectTask = (task: ScheduledTask) => {
		if (editingId === task.id) return;
		setSelectedId(task.id);
		setShowEditor(false);
		setActiveTab("detail");
	};

	const navigateToSession = useCallback(
		async (sessionId: string) => {
			setActiveAgentId(sessionId);
			setShowScheduledTasks(false);
			try {
				await window.look.activateSession(sessionId);
			} catch {
				toast.error(t("scheduledTasks.sessionOpenFailed"));
			}
		},
		[setActiveAgentId, setShowScheduledTasks, t],
	);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex h-12 items-center justify-between gap-4 border-b border-hairline px-5">
				<div className="flex min-w-0 items-center gap-3">
					<Button
						variant="outline"
						size="sm"
						className="gap-1 px-2.5 text-[11px]"
						onClick={() => setShowScheduledTasks(false)}
					>
						<ArrowLeft className="size-3.5" />
						{t("marketplace.back")}
					</Button>
					<div className="min-w-0">
						<h1 className="text-sm font-semibold">{t("scheduledTasks.title")}</h1>
						<p className="text-[11px] text-muted-foreground">{t("scheduledTasks.description")}</p>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-4">
					<div className="hidden items-center gap-3 text-[11px] text-muted-foreground sm:flex">
						<span className="flex items-center gap-1.5">
							<span className="size-1.5 rounded-full bg-emerald-500" />
							{activeCount} {t("scheduledTasks.active")}
						</span>
						<span className="flex items-center gap-1.5">
							<span className="size-1.5 rounded-full bg-muted-foreground/40" />
							{pausedCount} {t("scheduledTasks.paused")}
						</span>
					</div>
					<Button size="sm" onClick={openCreate}>
						<Plus className="size-3.5" />
						{t("scheduledTasks.newTask")}
					</Button>
				</div>
			</header>

			<div className="flex min-h-0 flex-1">
				<aside className="flex w-72 shrink-0 flex-col border-r border-hairline bg-muted/10">
					<div className="flex items-center justify-between border-b border-hairline px-3 py-2">
						<span className="text-[11px] font-medium text-muted-foreground">{t("scheduledTasks.tasks")}</span>
						<span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
							{tasks.length}
						</span>
					</div>
					<div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
						{tasks.length === 0 ? (
							<EmptyTaskList />
						) : (
							tasks.map((task) => (
								<TaskListItem
									key={task.id}
									task={task}
									selectedId={selectedId}
									projects={projects}
									describeSchedule={describeSchedule}
									selectTask={selectTask}
								/>
							))
						)}
					</div>
				</aside>

				<main className="flex min-h-0 min-w-0 flex-1 flex-col">
					{selected && !showEditor && (
						<div className="flex items-center justify-between border-b border-hairline px-4 py-1.5">
							<div className="flex items-center gap-1">
								<button
									type="button"
									onClick={() => setActiveTab("detail")}
									className={cn(
										"rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
										activeTab === "detail"
											? "bg-accent text-foreground"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									{t("scheduledTasks.details")}
								</button>
								<button
									type="button"
									onClick={() => setActiveTab("history")}
									className={cn(
										"rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
										activeTab === "history"
											? "bg-accent text-foreground"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									{t("scheduledTasks.history")}
								</button>
							</div>
							<div className="flex items-center gap-2">
								<Button
									variant="ghost"
									size="icon-xs"
									onClick={() => void refreshLogs(selectedId ?? undefined)}
								>
									<RotateCw className="size-3" />
								</Button>
							</div>
						</div>
					)}
					<div className="min-h-0 flex-1 overflow-y-auto p-5">
						{showEditor ? (
							<TaskEditor
								editingId={editingId}
								form={form}
								setForm={updateForm}
								projects={projects}
								models={models}
								imChannels={imChannels}
								busy={busy}
								testing={testing}
								testResult={testResult}
								closeEditor={closeEditor}
								save={save}
								testTask={testTask}
							/>
						) : selected ? (
							activeTab === "detail" ? (
								<TaskDetail
									task={selected}
									projects={projects}
									imChannels={imChannels}
									describeSchedule={describeSchedule}
									busy={busy}
									openEdit={openEdit}
									act={act}
								/>
							) : (
								<ExecutionHistory logs={logs} selected={selected} navigateToSession={navigateToSession} />
							)
						) : (
							<EmptyWorkspace />
						)}
					</div>
				</main>
			</div>
		</div>
	);
}
