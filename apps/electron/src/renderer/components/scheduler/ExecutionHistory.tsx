import { cn } from "@look/ui";
import type { ScheduledTask, ScheduledTaskRunLog } from "@shared/types";
import { AlertCircle, Clock3, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatDate, statusBadgeStyle, statusDotColor } from "./scheduleUtils";

export type ExecutionHistoryProps = {
	logs: ScheduledTaskRunLog[];
	selected: ScheduledTask | null;
	navigateToSession: (sessionId: string) => void;
};

export function ExecutionHistory({ logs, navigateToSession }: ExecutionHistoryProps) {
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
