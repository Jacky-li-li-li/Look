import { Badge } from "@look/ui/components/ui/badge";
import { Button } from "@look/ui/components/ui/button";
import type { ProjectInfo, ScheduledTask } from "@shared/types";
import { BellRing, CalendarDays, Clock3, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { WorkspaceEmptyState } from "../workspace/WorkspacePageChrome";
import { formatTimeLeft } from "./scheduleUtils";

export function EmptyTaskList({ onCreate }: { onCreate?: () => void }) {
	const { t } = useTranslation();
	return (
		<WorkspaceEmptyState
			icon={Clock3}
			title={t("scheduledTasks.empty")}
			description={t("scheduledTasks.emptyHint")}
			action={
				onCreate && (
					<Button variant="line" size="sm" onClick={onCreate}>
						<Plus className="size-3.5" />
						{t("scheduledTasks.createTask", "Create task")}
					</Button>
				)
			}
			className="min-h-0 rounded-lg border border-dashed border-hairline bg-background/25 px-3 py-6"
		/>
	);
}

export function EmptyWorkspace({ onCreate }: { onCreate?: () => void }) {
	const { t } = useTranslation();
	return (
		<WorkspaceEmptyState
			icon={CalendarDays}
			title={t("scheduledTasks.noSelection")}
			description={t("scheduledTasks.noSelectionHint")}
			action={
				onCreate && (
					<Button variant="line" size="sm" onClick={onCreate}>
						<Plus className="size-3.5" />
						{t("scheduledTasks.createTask", "Create task")}
					</Button>
				)
			}
			className="min-h-0"
		/>
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
	const isActive = task.status === "scheduled";
	return (
		<button
			type="button"
			aria-label={task.name}
			aria-pressed={isSelected}
			onClick={() => selectTask(task)}
			className={`group relative flex w-full cursor-pointer items-start gap-3 overflow-hidden rounded-xl border px-3 py-3 text-left outline-none transition-[border-color,background-color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring/50 ${isSelected ? "border-primary/45 bg-primary/[0.08] shadow-[0_6px_18px_var(--selection-glow)]" : "border-hairline bg-background/45 hover:border-primary/25 hover:bg-card/70"}`}
		>
			<span
				className={`absolute inset-y-3 left-0 w-0.5 rounded-r-full ${isActive ? "bg-emerald-500" : "bg-muted-foreground/35"}`}
				aria-hidden="true"
			/>
			<span
				className={`mt-1.5 size-2 shrink-0 rounded-full ${isActive ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
				aria-hidden="true"
			/>
			<span className="min-w-0 flex-1">
				<span className="flex items-start justify-between gap-2">
					<span className="min-w-0 truncate text-[12px] font-semibold text-foreground">{task.name}</span>
					<Badge
						variant="secondary"
						className={`h-5 shrink-0 px-1.5 text-[9px] ${isActive ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}
					>
						{isActive ? t("scheduledTasks.active") : t("scheduledTasks.paused")}
					</Badge>
				</span>
				<span className="mt-1 block truncate text-[10px] text-muted-foreground">{describeSchedule(task)}</span>
				<span className="mt-2 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground/75">
					<span className="min-w-0 truncate">{projectName}</span>
					{task.model && (
						<>
							<span aria-hidden="true" className="text-hairline">
								·
							</span>
							<span className="max-w-[9rem] truncate font-mono">{task.model}</span>
						</>
					)}
				</span>
			</span>
			<span className="flex shrink-0 flex-col items-end gap-1 text-[10px] text-muted-foreground">
				<span className="font-mono tabular-nums">{formatTimeLeft(task.nextRunAt)}</span>
				{task.notification?.enabled && (
					<BellRing className="size-3 text-primary/75" aria-label={t("scheduledTasks.imNotification")} />
				)}
			</span>
		</button>
	);
}
