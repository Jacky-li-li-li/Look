// ============================================================
// ExecutionProcess — Wraps thinking + tools into a collapsible panel
// ============================================================

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@shared/components/ui/collapsible";
import { cn } from "@shared/lib/utils";
import { ChevronRight, ListTree } from "lucide-react";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface ExecutionProcessProps {
	thinking?: string;
	toolCalls?: Array<{ callId: string; toolName: string; status: string }>;
	hasOutput: boolean;
	children: React.ReactNode;
}

export default function ExecutionProcess({ thinking, toolCalls, hasOutput, children }: ExecutionProcessProps) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(true);
	const autoCollapsed = React.useRef(false);

	// Auto-collapse when output content arrives (streaming starts)
	useEffect(() => {
		if (hasOutput && !autoCollapsed.current) {
			setOpen(false);
			autoCollapsed.current = true;
		}
	}, [hasOutput]);

	const stepCount = (thinking ? 1 : 0) + (toolCalls?.length ?? 0);
	if (stepCount === 0) return null;

	const steps: string[] = [];
	if (thinking) steps.push(`💭 ${t("execution.reasoning")}`);
	toolCalls?.forEach((tc) => {
		const icon = tc.status === "success" ? "✅" : tc.status === "error" ? "❌" : tc.status === "running" ? "⟳" : "🔧";
		steps.push(`${icon} ${tc.toolName}`);
	});

	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<div className="inset-drawer">
				<CollapsibleTrigger asChild>
					<button className="inset-drawer__trigger">
						<ChevronRight
							className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")}
						/>
						<ListTree className="size-3.5 shrink-0 text-amber-400" />
						<span className="min-w-0 flex-1 truncate text-left font-medium text-foreground">
							{t("execution.executionProcess")}
						</span>
						<span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
							{t("execution.steps", { count: stepCount })}
							&nbsp;·&nbsp;
							{open ? t("execution.expanded") : t("execution.collapsed")}
						</span>
					</button>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<div className="inset-drawer__content" style={{ maxHeight: "none", overflow: "visible" }}>
						<div className="flex flex-col gap-2">{children}</div>
					</div>
				</CollapsibleContent>
			</div>
		</Collapsible>
	);
}
