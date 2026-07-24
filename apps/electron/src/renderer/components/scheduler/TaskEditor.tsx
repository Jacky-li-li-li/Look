import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import { Label } from "@shared/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@shared/components/ui/select";
import { Switch } from "@shared/components/ui/switch";
import { Textarea } from "@shared/components/ui/textarea";
import { cn } from "@shared/lib/utils";
import type { ProjectInfo, ScheduledTaskRunLog, ScheduledTaskSchedule } from "@shared/types";
import { AlertCircle, BellRing, CalendarDays, CheckCircle2, FlaskConical, LoaderCircle, X } from "lucide-react";
import { useCallback, useId } from "react";
import { useTranslation } from "react-i18next";
import {
	effectiveChatId,
	type FormState,
	type ImBinding,
	type ImChannel,
	type ModelChoice,
	maskAppId,
	p2pCandidatesFor,
} from "./scheduleUtils";

export type TaskEditorProps = {
	editingId: string | null;
	form: FormState;
	setForm: React.Dispatch<React.SetStateAction<FormState>>;
	projects: ProjectInfo[];
	models: ModelChoice[];
	imChannels: ImChannel[];
	imBindings: ImBinding[];
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

export function TaskEditor({
	editingId,
	form,
	setForm,
	projects,
	models,
	imChannels,
	imBindings,
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
	const handleNotificationChatChange = useCallback(
		(notificationChatId: string) => setForm((prev) => ({ ...prev, notificationChatId })),
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
	// 所选渠道下可推送的私聊会话；收件人由用户显式选择并随任务持久化
	const chatCandidates = p2pCandidatesFor(imBindings, form.notificationChannel);
	const selectedChatId = effectiveChatId(chatCandidates, form.notificationChatId);

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
							{chatCandidates.length > 0 ? (
								<>
									<Select value={selectedChatId} onValueChange={handleNotificationChatChange}>
										<SelectTrigger className="mt-2">
											<SelectValue placeholder={t("scheduledTasks.selectNotificationConversation")} />
										</SelectTrigger>
										<SelectContent>
											{chatCandidates.map((binding) => (
												<SelectItem key={binding.chatId} value={binding.chatId}>
													{binding.peerName || `…${binding.chatId.slice(-8)}`}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<p className="mt-2 text-[10px] text-muted-foreground">{t("scheduledTasks.imP2pHint")}</p>
								</>
							) : (
								<p className="mt-2 text-[10px] text-amber-600 dark:text-amber-400">
									{t("scheduledTasks.imNoP2p")}
								</p>
							)}
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
