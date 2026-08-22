import { cn } from "@look/ui";
import type { ScheduledTask, ScheduledTaskRunLog } from "@shared/types";
import { AlertCircle, Clock3, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { WorkspaceEmptyState } from "../workspace/WorkspacePageChrome";
import { formatDate, statusBadgeStyle, statusDotColor } from "./scheduleUtils";

export type ExecutionHistoryProps = {
	logs: ScheduledTaskRunLog[];
	selected: ScheduledTask | null;
	navigateToSession: (sessionId: string) => void;
};

export function ExecutionHistory({ logs, navigateToSession }: ExecutionHistoryProps) {
	const { t } = useTranslation();
	const statusLabels: Record<string, string> = {
		running: t("scheduledTasks.statusRunning"),
		retrying: t("scheduledTasks.statusRetrying"),
		success: t("scheduledTasks.statusSuccess"),
		failed: t("scheduledTasks.statusFailed"),
		skipped: t("scheduledTasks.statusSkipped"),
		interrupted: t("scheduledTasks.statusInterrupted"),
	};

	if (logs.length === 0) {
		return <WorkspaceEmptyState icon={Clock3} title={t("scheduledTasks.noRuns")} className="min-h-[280px]" />;
	}

	return (
		<div className="relative mx-auto w-full max-w-4xl">
			<div className="absolute bottom-5 left-[7px] top-5 w-px bg-border" aria-hidden="true" />
			<div className="space-y-3">
				{logs.map((log) => (
					<article key={log.id} className="group relative">
						<span
							className={cn(
								"absolute left-0 top-4 z-10 size-3.5 rounded-full border-[3px] border-background transition-shadow",
								statusDotColor(log.status),
								"group-hover:shadow-[0_0_0_3px_var(--selection-glow)]",
							)}
							aria-hidden="true"
						/>
						<div className="ml-6 rounded-xl border border-hairline bg-card/35 p-3 transition-[border-color,background-color] group-hover:border-primary/20 group-hover:bg-card/55 sm:p-3.5">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<div className="flex min-w-0 items-center gap-2">
									<span
										className={cn(
											"shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
											statusBadgeStyle(log.status),
										)}
									>
										{statusLabels[log.status] ?? log.status}
									</span>
									{log.attempt > 1 && (
										<span className="text-[10px] text-muted-foreground">
											{t("scheduledTasks.attemptLabel", { attempt: log.attempt, max: log.maxAttempts })}
										</span>
									)}
								</div>
								<span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
									{formatDate(log.startedAt)}
								</span>
							</div>

							{log.errorMessage && (
								<div className="mt-2 flex items-start gap-1.5 rounded-lg border border-destructive/15 bg-destructive/[0.06] px-2.5 py-2">
									<AlertCircle className="mt-0.5 size-3 shrink-0 text-destructive" />
									<p className="text-[10px] leading-relaxed text-destructive/85">{log.errorMessage}</p>
								</div>
							)}
							{log.sessionId && log.status === "success" && (
								<button
									type="button"
									className="mt-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-primary transition-colors hover:bg-primary/10 hover:text-primary"
									onClick={() => log.sessionId && navigateToSession(log.sessionId)}
								>
									{log.taskName}
									<ExternalLink className="size-3" />
								</button>
							)}
							{log.sessionId && log.status !== "success" && (
								<p className="mt-2 text-[11px] text-muted-foreground/60">{log.taskName}</p>
							)}
							{!log.sessionId && log.output && (
								<p className="mt-2 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
									{log.output}
								</p>
							)}
							{log.notificationStatus && (
								<p
									className={cn(
										"mt-2 text-[10px]",
										log.notificationStatus === "failed" ? "text-destructive/75" : "text-muted-foreground",
									)}
								>
									{log.notificationStatus === "sent"
										? t("scheduledTasks.notificationSent")
										: t("scheduledTasks.notificationFailed", { error: log.notificationError })}
								</p>
							)}
						</div>
					</article>
				))}
			</div>
		</div>
	);
}
