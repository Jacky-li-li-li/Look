import { cn } from "@look/ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "@look/ui/components/ui/tooltip";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { activeAgentIdAtom, agentsAtom, sessionStateAtomFamily } from "../../store/atoms";

const RING_RADIUS = 10;
const STROKE_WIDTH = 2.5;
const VIEWBOX_SIZE = 28;
const CENTER = VIEWBOX_SIZE / 2;
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const colorMap = {
	safe: "stroke-emerald-400",
	warning: "stroke-amber-400",
	critical: "stroke-red-400",
} as const;

export default function ContextRing() {
	const { t } = useTranslation();
	const sessionId = useAtomValue(activeAgentIdAtom);

	const sessionState = useAtomValue(sessionStateAtomFamily(sessionId ?? ""));

	const agents = useAtomValue(agentsAtom);
	const agentInfo = agents.find((a) => a.id === sessionId);

	// sessionState.runtime.isCompacting is the single source of truth from the snapshot path.
	// Fall back to agentInfo for sessions where runtime hasn't arrived yet (boot race).
	const contextUsage = agentInfo?.contextUsage ?? sessionState.runtime?.contextUsage;
	const compacting = sessionState.runtime?.isCompacting ?? agentInfo?.isCompacting ?? false;
	const isStreaming = sessionState.runtime?.isStreaming ?? agentInfo?.isStreaming ?? false;

	const percentage = Math.max(0, Math.min(100, contextUsage?.percent ?? 0));
	const usedTokens = contextUsage?.tokens ?? 0;
	const totalTokens = contextUsage?.contextWindow ?? 0;

	const [pulsing, setPulsing] = useState(false);
	useEffect(() => {
		const shouldPulse = percentage >= 80 && !compacting;
		setPulsing(shouldPulse);
		if (!shouldPulse) return;
		const timer = setTimeout(() => setPulsing(false), 8000);
		return () => clearTimeout(timer);
	}, [percentage, compacting]);

	const level = useMemo(() => {
		if (percentage >= 90) return "critical";
		if (percentage >= 70) return "warning";
		return "safe";
	}, [percentage]);

	const offset = CIRCUMFERENCE - (percentage / 100) * CIRCUMFERENCE;

	// contextUsage may be undefined for historical sessions or during initial load.
	// When undefined, allow the click — pi SDK will throw if there's nothing to compact,
	// and the error is surfaced via the IpcResult.success check.
	const canCompress = !compacting && !isStreaming && (contextUsage == null || percentage >= 5);

	const handleClick = useCallback(() => {
		if (!canCompress || !sessionId) return;
		window.look
			.compressSession(sessionId)
			.then((result) => {
				if (!result.success) {
					console.warn("[ContextRing] compressSession failed:", result.error);
				}
			})
			.catch((err) => console.error("[ContextRing] compressSession failed:", err));
	}, [canCompress, sessionId]);

	if (!sessionId) return null;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={handleClick}
					disabled={!canCompress}
					className={cn(
						"group relative flex size-7 items-center justify-center rounded-md transition-colors",
						"hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40",
						pulsing && "animate-pulse",
					)}
				>
					<svg viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`} className="size-5 -rotate-90">
						<circle
							cx={CENTER}
							cy={CENTER}
							r={RING_RADIUS}
							fill="none"
							strokeWidth={STROKE_WIDTH}
							className="stroke-muted-foreground/40"
						/>
						<circle
							cx={CENTER}
							cy={CENTER}
							r={RING_RADIUS}
							fill="none"
							strokeWidth={STROKE_WIDTH}
							strokeLinecap="round"
							strokeDasharray={CIRCUMFERENCE}
							strokeDashoffset={offset}
							className={cn("transition-all duration-500 ease-out", colorMap[level])}
						/>
					</svg>
					{compacting && (
						<span className="absolute size-3 animate-spin rounded border-2 border-muted-foreground border-t-transparent" />
					)}
				</button>
			</TooltipTrigger>
			<TooltipContent side="top" className="max-w-[220px] text-center">
				{compacting ? (
					<p className="text-[11px] leading-relaxed opacity-80">{t("context.compressing")}</p>
				) : isStreaming ? (
					<p className="text-[11px] leading-relaxed opacity-80">{t("context.stopFirst")}</p>
				) : (
					<div className="flex flex-col gap-0.5 text-[11px] leading-relaxed">
						<span className="font-semibold tabular-nums">{percentage.toFixed(0)}%</span>
						<span className="opacity-70 tabular-nums">
							{formatTokens(usedTokens)} / {formatTokens(totalTokens)}
						</span>
						{percentage >= 5 && (
							<span className="mt-0.5 text-[10px] opacity-50">{t("context.clickToCompress")}</span>
						)}
					</div>
				)}
			</TooltipContent>
		</Tooltip>
	);
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
	return String(value);
}
