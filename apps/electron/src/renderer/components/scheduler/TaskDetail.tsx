import { Badge } from "@look/ui/components/ui/badge";
import { Button } from "@look/ui/components/ui/button";
import type { ProjectInfo, ScheduledTask } from "@shared/types";
import { BellRing, CirclePause, CirclePlay, Pencil, Play, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatDate, formatTimeLeft, type ImBinding, type ImChannel, maskAppId } from "./scheduleUtils";

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
