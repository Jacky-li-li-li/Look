import { cn } from "@look/ui";
import { Button } from "@look/ui/components/ui/button";
import type { ProjectInfo, ScheduledTask, ScheduledTaskRunLog } from "@shared/types";
import { useAtomValue, useSetAtom } from "jotai";
import { ArrowLeft, Plus, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { activeAgentIdAtom, sidebarEffectiveCollapsedAtom } from "../../store/atoms";
import { navigateMainView } from "../../store/viewNavigation";
import { ExecutionHistory } from "./ExecutionHistory";
import {
	buildScheduledTaskInput,
	createEmptyForm,
	type FormState,
	type ImBinding,
	type ImChannel,
	localDateInput,
	type ModelChoice,
	scheduleForTask,
} from "./scheduleUtils";
import { TaskDetail } from "./TaskDetail";
import { TaskEditor } from "./TaskEditor";
import { EmptyTaskList, EmptyWorkspace, TaskListItem } from "./TaskList";

function formatDate(value?: string): string {
	if (!value) return "—";
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default function ScheduledTasksPage() {
	const { t } = useTranslation();
	const setActiveAgentId = useSetAtom(activeAgentIdAtom);
	const sidebarCollapsed = useAtomValue(sidebarEffectiveCollapsedAtom);
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
			notificationChatId: task.notification?.targetChatId ?? "",
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

	const buildInput = () => {
		const result = buildScheduledTaskInput(form, imBindings, t);
		if ("error" in result) {
			toast.error(result.error);
			return null;
		}
		return result.input;
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
			try {
				const result = await window.look.activateSession(sessionId);
				if (!result?.success) throw new Error(result?.error ?? t("scheduledTasks.sessionOpenFailed"));
				setActiveAgentId(sessionId);
				navigateMainView("chat");
			} catch (error) {
				toast.error(error instanceof Error ? error.message : t("scheduledTasks.sessionOpenFailed"));
			}
		},
		[setActiveAgentId, t],
	);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header
				className={cn(
					"app-drag flex h-12 items-center justify-between gap-4 border-b border-hairline px-5",
					sidebarCollapsed && "mac-titlebar-pad",
				)}
			>
				<div className="flex min-w-0 items-center gap-3">
					<Button
						variant="outline"
						size="sm"
						className="gap-1 px-2.5 text-[11px]"
						onClick={() => navigateMainView("chat")}
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
								imBindings={imBindings}
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
									imBindings={imBindings}
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
