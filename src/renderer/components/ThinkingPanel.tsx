// ============================================================
// ThinkingPanel — Inset Drawer (Ink Wash, shadcn/ui)
// Auto-expands while streaming, auto-collapses when text starts
// (controlled by autoCollapse setting). User manual toggle
// overrides auto-behavior for the lifetime of this panel.
//
// NOTE: Uses pure CSS collapse instead of Radix Collapsible to
// avoid expensive hook overhead (Presence/useLayoutEffect) during
// agent switches where many panels mount simultaneously.
// ============================================================

import { cn } from "@shared/lib/utils";
import { Brain, ChevronRight } from "lucide-react";
import React from "react";

interface ThinkingPanelProps {
	thinking: string;
	isStreaming: boolean;
	autoCollapse: boolean;
}

export default function ThinkingPanel({ thinking, isStreaming, autoCollapse }: ThinkingPanelProps) {
	const [open, setOpen] = React.useState(isStreaming);
	const userManuallyToggled = React.useRef(false);
	const prevStreaming = React.useRef(isStreaming);

	// When streaming ends, auto-collapse if setting enabled and user hasn't manually toggled
	React.useEffect(() => {
		if (prevStreaming.current === true && isStreaming === false) {
			if (autoCollapse && !userManuallyToggled.current) {
				setOpen(false);
			}
		}
		prevStreaming.current = isStreaming;
	}, [isStreaming, autoCollapse]);

	// When streaming but no thinking content has arrived yet, show a loading
	// skeleton with a pulse indicator so the user knows reasoning is in progress.
	if (!thinking) {
		if (!isStreaming) return null;
		return (
			<div className="flex items-center gap-2 px-2.5 py-2 text-[11px] text-muted-foreground cursor-default">
					<ChevronRight className="size-3 shrink-0" />
					<Brain className="size-3.5 shrink-0 text-blue-400" />
					<span className="min-w-0 flex-1 truncate text-left font-medium text-foreground">Reasoning</span>
					<span className="inline-block w-2 h-4 bg-blue-400 animate-pulse rounded-xs" />
			</div>
		);
	}

	return (
		<div>
			<button
				className="flex w-full items-center gap-2 px-2.5 py-2 text-left outline-none text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
				onClick={() => {
					userManuallyToggled.current = true;
					setOpen((v) => !v);
				}}
			>
				<ChevronRight className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")} />
				<Brain className="size-3.5 shrink-0 text-blue-400" />
				<span className="min-w-0 flex-1 truncate text-left font-medium text-foreground">Reasoning</span>
				<span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
					{thinking.length.toLocaleString()} chars
				</span>
			</button>
			<div
				className={cn(
					"grid transition-all duration-200 ease-out",
					open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
				)}
			>
				<div className="overflow-hidden">
					<div className="px-3 py-2.5 max-h-72 overflow-auto text-[11px] leading-relaxed text-muted-foreground">
						<div className="whitespace-pre-wrap break-words leading-relaxed">{thinking}</div>
					</div>
				</div>
			</div>
		</div>
	);
}
