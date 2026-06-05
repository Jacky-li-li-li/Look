// ============================================================
// ThinkingPanel — Inset Drawer (Ink Wash, shadcn/ui)
// ============================================================

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@shared/components/ui/collapsible";
import { cn } from "@shared/lib/utils";
import { Brain, ChevronRight } from "lucide-react";
import React from "react";

interface ThinkingPanelProps {
	thinking: string;
}

export default function ThinkingPanel({ thinking }: ThinkingPanelProps) {
	const [open, setOpen] = React.useState(false);

	if (!thinking) return null;

	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<div className="inset-drawer">
				<CollapsibleTrigger asChild>
					<button className="inset-drawer__trigger">
						<ChevronRight
							className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")}
						/>
						<Brain className="size-3.5 shrink-0 text-blue-400" />
						<span className="min-w-0 flex-1 truncate text-left font-medium text-foreground">Reasoning</span>
						<span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
							{thinking.length.toLocaleString()} chars
						</span>
					</button>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<div className="inset-drawer__content text-muted-foreground">
						<div className="whitespace-pre-wrap break-words leading-relaxed">{thinking}</div>
					</div>
				</CollapsibleContent>
			</div>
		</Collapsible>
	);
}
