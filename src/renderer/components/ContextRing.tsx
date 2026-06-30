import { Tooltip, TooltipContent, TooltipTrigger } from "@shared/components/ui/tooltip";
import { cn } from "@shared/lib/utils";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { activeAgentIdAtom, sessionStateAtomFamily } from "../store/atoms";

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
	const sessionId = useAtomValue(activeAgentIdAtom) ?? "";
	const sessionState = useAtomValue(sessionStateAtomFamily(sessionId));
	const contextUsage = sessionState.runtime?.contextUsage;
	const compacting = sessionState.runtime?.isCompacting ?? false;
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

	const handleClick = useCallback(() => {
		if (!sessionId || compacting || percentage < 5) return;
		void window.look.compressSession(sessionId);
	}, [sessionId, compacting, percentage]);

	const level = useMemo(() => {
		if (percentage >= 90) return "critical";
		if (percentage >= 70) return "warning";
		return "safe";
	}, [percentage]);
	const offset = CIRCUMFERENCE - (percentage / 100) * CIRCUMFERENCE;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={handleClick}
					disabled={compacting || percentage < 1}
					className={cn(
						"group relative flex size-7 items-center justify-center rounded-md border border-hairline transition-colors",
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
					<p className="text-[11px]">Compressing…</p>
				) : (
					<div className="flex flex-col gap-0.5 text-[11px]">
						<span>{percentage.toFixed(0)}% context used</span>
						<span className="text-muted-foreground">
							{formatTokens(usedTokens)} / {formatTokens(totalTokens)}
						</span>
						<span className="text-[10px] text-muted-foreground/60">Click to compress</span>
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
