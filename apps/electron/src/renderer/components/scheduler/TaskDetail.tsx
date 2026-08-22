import { Badge } from "@look/ui/components/ui/badge";
import { Button } from "@look/ui/components/ui/button";
import type { ProjectInfo, ScheduledTask } from "@shared/types";
import { BellRing, CirclePause, CirclePlay, Pencil, Play, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { WorkspaceSectionHeading } from "../workspace/WorkspacePageChrome";
import {
	formatDate,
	formatTimeLeft,
	type ImBinding,
	type ImChannel,
	maskAppId,
	scheduleForTask,
} from "./scheduleUtils";

export type TaskDetailProps = {
	task: ScheduledTask;
	projects: ProjectInfo[];
	imChannels: ImChannel[];
	imBindings: ImBinding[];
	describeSchedule: (task: ScheduledTask) => string;
	busy: boolean;
	openEdit: (task: ScheduledTask) => void;
	act: (action: "start" | "pause" | "run" | "delete", task: ScheduledTask) => void;
};

export function TaskDetail({
	task,
	projects,
	imChannels,
	imBindings,
	describeSchedule,
	busy,
	openEdit,
	act,
}: TaskDetailProps) {
	const { t } = useTranslation();
	const projectName = projects.find((p) => p.id === task.projectId)?.name ?? task.projectId;
	const notificationTarget = (() => {
		const notification = task.notification;
		if (!notification?.enabled) return null;
		const channelLabel = notification.channelAppId
			? imChannels.find((c) => c.appId === notification.channelAppId)?.name || maskAppId(notification.channelAppId)
			: null;
		// 显式会话目标：优先显示私聊对端姓名
		if (notification.targetChatId) {
			const peer = imBindings.find((b) => b.chatId === notification.targetChatId)?.peerName;
			const chatLabel = peer || `…${notification.targetChatId.slice(-8)}`;
			return channelLabel ? `${channelLabel} · ${chatLabel}` : chatLabel;
		}
		// channel-only 旧任务：发送时解析为该 bot 的私聊
		return channelLabel ? `${channelLabel} · ${t("scheduledTasks.imPrivateChat")}` : null;
	})();
	const isActive = task.status === "scheduled";
	const schedule = scheduleForTask(task);
	const runNow = () => {
		if (schedule.kind === "once" && !window.confirm(t("scheduledTasks.runOnceConfirm"))) return;
		void act("run", task);
	};

	return (
		<div className="mx-auto w-full max-w-4xl space-y-5">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2.5">
						<h2 className="min-w-0 truncate text-lg font-semibold tracking-tight">{task.name}</h2>
						<Badge
							variant="secondary"
							className={
								isActive ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
							}
						>
							{isActive ? t("scheduledTasks.active") : t("scheduledTasks.paused")}
						</Badge>
					</div>
					<p className="mt-1 truncate text-[11px] text-muted-foreground">
						{t("scheduledTasks.project")}: {projectName}
					</p>
				</div>
				<div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
					<Button
						variant="line"
						size="sm"
						onClick={() => openEdit(task)}
						aria-label={t("scheduledTasks.edit")}
						title={t("scheduledTasks.edit")}
					>
						<Pencil className="size-3.5" />
						<span className="hidden sm:inline">{t("scheduledTasks.edit")}</span>
					</Button>
					<Button
						variant="line"
						size="sm"
						onClick={runNow}
						disabled={busy}
						aria-label={t("scheduledTasks.runNow")}
						title={t("scheduledTasks.runNow")}
					>
						<Play className="size-3.5" />
						<span className="hidden sm:inline">{t("scheduledTasks.runNow")}</span>
					</Button>
					<Button
						variant="line"
						size="sm"
						onClick={() => void act(isActive ? "pause" : "start", task)}
						disabled={busy}
						aria-label={isActive ? t("scheduledTasks.pause") : t("scheduledTasks.start")}
						title={isActive ? t("scheduledTasks.pause") : t("scheduledTasks.start")}
					>
						{isActive ? <CirclePause className="size-3.5" /> : <CirclePlay className="size-3.5" />}
						<span className="hidden sm:inline">
							{isActive ? t("scheduledTasks.pause") : t("scheduledTasks.start")}
						</span>
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={t("common.delete")}
						title={t("common.delete")}
						onClick={() => void act("delete", task)}
						disabled={busy}
					>
						<Trash2 className="size-4 text-destructive" />
					</Button>
				</div>
			</div>

			<div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-4">
				<div className="min-w-0 bg-background/65 p-3">
					<span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
						{t("scheduledTasks.frequency")}
					</span>
					<p className="mt-1 truncate text-[12px] font-semibold">{describeSchedule(task)}</p>
				</div>
				<div className="min-w-0 bg-background/65 p-3">
					<span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
						{t("scheduledTasks.next")}
					</span>
					<p className="mt-1 truncate text-[12px] font-semibold">{formatDate(task.nextRunAt)}</p>
					<p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{formatTimeLeft(task.nextRunAt)}</p>
				</div>
				<div className="min-w-0 bg-background/65 p-3">
					<span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
						{t("scheduledTasks.model")}
					</span>
					<p className="mt-1 truncate font-mono text-[12px] font-semibold">{task.model ?? "—"}</p>
				</div>
				<div className="min-w-0 bg-background/65 p-3">
					<span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
						{t("scheduledTasks.attempts")}
					</span>
					<p className="mt-1 text-[12px] font-semibold">
						{task.retry.maxAttempts} / {task.retry.initialDelayMs / 1_000}s
					</p>
				</div>
			</div>

			<section className="space-y-2.5">
				<WorkspaceSectionHeading title={t("scheduledTasks.prompt")} />
				<div className="max-h-56 overflow-y-auto rounded-xl border border-hairline bg-muted/[0.14] px-4 py-3">
					<p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed">{task.prompt}</p>
				</div>
			</section>

			{Object.keys(task.parameters).length > 0 && (
				<section className="space-y-2.5">
					<WorkspaceSectionHeading title={t("scheduledTasks.parameters")} />
					<div className="max-h-44 overflow-auto rounded-xl border border-hairline bg-muted/[0.14] px-4 py-3">
						<pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
							{JSON.stringify(task.parameters, null, 2)}
						</pre>
					</div>
				</section>
			)}

			{notificationTarget && (
				<div className="flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/[0.06] px-3 py-2.5">
					<BellRing className="size-3.5 shrink-0 text-primary" />
					<span className="truncate text-[11px] text-muted-foreground">
						{t("scheduledTasks.imEnabled")} · {notificationTarget}
					</span>
				</div>
			)}
		</div>
	);
}
