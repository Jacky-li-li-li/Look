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

	if (!thinking) return null;

	return (
		<div className="inset-drawer">
			<button
				className="inset-drawer__trigger"
				onClick={() => {
					userManuallyToggled.current = true;
					setOpen((v) => !v);
				}}
			>
				<ChevronRight
					className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")}
				/>
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
					<div className="inset-drawer__content text-muted-foreground">
						<div className="whitespace-pre-wrap break-words leading-relaxed">{thinking}</div>
					</div>
				</div>
			</div>
		</div>
	);
}