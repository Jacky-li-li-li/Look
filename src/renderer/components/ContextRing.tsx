// ============================================================
// ContextRing — SVG ring showing context usage with color & pulse
// Ink Wash design, shadcn/ui-adjacent styling
// ============================================================

import { cn } from "@shared/lib/utils";
import type { ContextUsageInfo } from "@shared/types";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { activeAgentIdAtom } from "../store/atoms";

const api = (window as any).look;

interface ContextRingProps {
	onUsageChange?: (usage: ContextUsageInfo) => void;
}

const RING_RADIUS = 10;
const STROKE_WIDTH = 2.5;
const VIEWBOX_SIZE = 28;
const CENTER = VIEWBOX_SIZE / 2;
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export default function ContextRing({ onUsageChange }: ContextRingProps) {
	const agentId = useAtomValue(activeAgentIdAtom) ?? "";
	const [usage, setUsage] = useState<ContextUsageInfo>({
		percentage: 0,
		usedTokens: 0,
		totalTokens: 128000,
		level: "safe",
		compacting: false,
	});
	const [pulsing, setPulsing] = useState(false);

	// Poll usage every 3s when agent is active
	useEffect(() => {
		if (!api || !agentId) return;
		let mounted = true;

		const poll = async () => {
			try {
				const r = await api.getContextUsage(agentId);
				if (!mounted) return;
				if (r?.success && r.usage) {
					setUsage(r.usage);
					onUsageChange?.(r.usage);
				}
			} catch {
				/* ignore */
			}
		};

		poll();
		const interval = setInterval(poll, 3000);
		return () => {
			mounted = false;
			clearInterval(interval);
		};
	}, [agentId, onUsageChange]);

	// Pulse when crossing 80% threshold
	useEffect(() => {
		if (usage.percentage >= 80 && !usage.compacting) {
			setPulsing(true);
			const timer = setTimeout(() => setPulsing(false), 8000);
			return () => clearTimeout(timer);
		} else {
			setPulsing(false);
		}
	}, [usage.percentage, usage.compacting]);

	// Fall back to event-based updates for immediate response
	useEffect(() => {
		if (!api || !agentId) return;
		const unsub = api.onEvent((event: any) => {
			if (event.type === "agent:context-usage" && event.agentId === agentId) {
				setUsage(event.usage);
				onUsageChange?.(event.usage);
			}
			if (event.type === "agent:compacting" && event.agentId === agentId) {
				setUsage((prev) => ({ ...prev, compacting: event.compacting }));
			}
		});
		return unsub;
	}, [agentId, onUsageChange]);

	const handleClick = useCallback(async () => {
		if (usage.compacting || !api) return;
		if (usage.percentage < 5) return; // nothing to compress
		setUsage((prev) => ({ ...prev, compacting: true }));
		try {
			await api.compressSession(agentId);
			// Refresh usage after compress
			const r = await api.getContextUsage(agentId);
			if (r?.success && r.usage) {
				setUsage(r.usage);
				onUsageChange?.(r.usage);
			}
		} catch {
			/* ignore */
		}
	}, [agentId, usage.percentage, usage.compacting, onUsageChange]);

	const offset = CIRCUMFERENCE - (usage.percentage / 100) * CIRCUMFERENCE;

	const colorMap = {
		safe: "stroke-emerald-400",
		warning: "stroke-amber-400",
		critical: "stroke-red-400",
	};

	return (
		<button
			type="button"
			onClick={handleClick}
			disabled={usage.compacting || usage.percentage < 1}
			className={cn(
				"group relative flex size-7 items-center justify-center rounded-md transition-colors border border-hairline",
				"hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed",
				pulsing && "animate-pulse",
			)}
			title={
				usage.compacting
					? "Compressing…"
					: `${usage.percentage}% context used (${formatTokens(usage.usedTokens)} / ${formatTokens(usage.totalTokens)})\nClick to compress`
			}
		>
			<svg viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`} className="size-5 -rotate-90">
				{/* Background track */}
				<circle
					cx={CENTER}
					cy={CENTER}
					r={RING_RADIUS}
					fill="none"
					strokeWidth={STROKE_WIDTH}
					className="stroke-muted-foreground/40"
				/>
				{/* Usage arc */}
				<circle
					cx={CENTER}
					cy={CENTER}
					r={RING_RADIUS}
					fill="none"
					strokeWidth={STROKE_WIDTH}
					strokeLinecap="round"
					strokeDasharray={CIRCUMFERENCE}
					strokeDashoffset={offset}
					className={cn("transition-all duration-500 ease-out", colorMap[usage.level])}
				/>
			</svg>
			{usage.compacting && (
				<span className="absolute size-3 animate-spin rounded border-2 border-t-transparent border-muted-foreground" />
			)}
		</button>
	);
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
	return String(n);
}
