// ============================================================
// SubagentProgressCard — 父会话消息流中的子 Agent 进度卡（Stage 5）
// ============================================================

import { cn } from "@shared/lib/utils";
import { Bot, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { memo } from "react";
import type { SubagentProgressEntry } from "../store/atoms";

interface Props {
	entry: SubagentProgressEntry;
	onClick?: () => void;
}

const STATUS_ICONS: Record<string, typeof CheckCircle2> = {
	running: Loader2,
	completed: CheckCircle2,
	failed: XCircle,
	aborted: XCircle,
};

const STATUS_COLORS: Record<string, string> = {
	running: "text-amber-500",
	completed: "text-emerald-500",
	failed: "text-red-500",
	aborted: "text-muted-foreground/50",
};

const STATUS_LABELS: Record<string, string> = {
	running: "执行中",
	completed: "已完成",
	failed: "失败",
	aborted: "已中止",
};

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

const SubagentProgressCard = memo(function SubagentProgressCard({ entry, onClick }: Props) {
	const Icon = STATUS_ICONS[entry.status] ?? Loader2;
	const isRunning = entry.status === "running";

	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"mx-5 mb-1.5 flex items-center gap-2.5 rounded-lg border border-hairline bg-card/30 px-3 py-2 text-left transition-colors hover:bg-card/50",
				onClick && "cursor-pointer",
			)}
		>
			<Bot className="size-3.5 shrink-0 text-muted-foreground/50" />
			<Icon className={cn("size-3.5 shrink-0", STATUS_COLORS[entry.status] ?? "", isRunning && "animate-spin")} />
			<div className="min-w-0 flex-1">
				<span className="text-[11px] font-medium">
					{entry.agentName}
					<span className={cn("ml-1.5 text-[10px]", STATUS_COLORS[entry.status] ?? "")}>
						{STATUS_LABELS[entry.status] ?? entry.status}
					</span>
				</span>
				{entry.usage && (
					<span className="ml-2 font-mono text-[9px] text-muted-foreground/50">
						{entry.usage.turns > 0 && `${entry.usage.turns} turns, `}↑{formatTokens(entry.usage.input)} ↓
						{formatTokens(entry.usage.output)}
						{entry.usage.cost > 0 && ` $${entry.usage.cost.toFixed(4)}`}
					</span>
				)}
				{entry.finalOutput && (
					<p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-muted-foreground">{entry.finalOutput}</p>
				)}
				{entry.errorMessage && <p className="mt-0.5 text-[10px] leading-snug text-red-500">{entry.errorMessage}</p>}
			</div>
		</button>
	);
});

export default SubagentProgressCard;
