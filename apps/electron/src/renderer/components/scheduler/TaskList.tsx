import { Badge } from "@look/ui/components/ui/badge";
import type { ProjectInfo, ScheduledTask } from "@shared/types";
import { BellRing, CalendarDays, Clock3 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatTimeLeft } from "./scheduleUtils";

export function EmptyTaskList() {
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

export function EmptyWorkspace() {
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

export function TaskListItem({ task, selectedId, projects, describeSchedule, selectTask }: TaskListItemProps) {
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
