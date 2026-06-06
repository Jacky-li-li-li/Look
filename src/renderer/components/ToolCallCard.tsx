// ============================================================
// ToolCallCard — Inset Drawer (Ink Wash, shadcn/ui)
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@shared/components/ui/collapsible";
import { cn } from "@shared/lib/utils";
import type { ToolCallRecord } from "@shared/types";
import { Check, ChevronRight, Loader2, Wrench, X } from "lucide-react";
import React from "react";

interface ToolCallCardProps {
	toolCall: ToolCallRecord;
}

/** Threshold: tool result text longer than this shows a summary + "show more" button */
const RESULT_SUMMARY_LIMIT = 500;

function formatResultSummary(toolCall: ToolCallRecord): string | null {
	const { toolName, result } = toolCall;
	if (!result || result.length === 0) return null;

	// For `read` tool: show path + size summary instead of full content
	if (toolName === "read") {
		const path = String(toolCall.args?.path ?? "?");
		const lines = result.split("\n").length;
		const bytes = result.length;
		const kb = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
		return `读取 ${path}（${lines} 行, ${kb}）`;
	}

	// For other tools with large output: show first line + size
	if (result.length > RESULT_SUMMARY_LIMIT) {
		const firstLine = result.split("\n")[0]?.slice(0, 120) ?? "";
		const lines = result.split("\n").length;
		const suffix = firstLine.length < result.split("\n")[0]!.length ? "…" : "";
		return `${firstLine}${suffix}（${lines} 行, ${result.length} 字符）`;
	}

	return null; // short enough to show inline
}

export default function ToolCallCard({ toolCall }: ToolCallCardProps) {
	const [open, setOpen] = React.useState(false);

	const argsJson = safeJson(toolCall.args);
	const argsPreview = argsJson.slice(0, 80);
	const hasBody = (toolCall.result && toolCall.result.length > 0) || argsPreview.length > 0;

	// For read/bash tools with large output, show inline summary when collapsed
	const resultSummary = !open ? formatResultSummary(toolCall) : null;
	const resultTooLong = toolCall.result ? toolCall.result.length > RESULT_SUMMARY_LIMIT : false;

	const statusVariant =
		toolCall.status === "success" ? "outline" : toolCall.status === "error" ? "destructive" : "secondary";

	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<div className="inset-drawer">
				<CollapsibleTrigger asChild>
					<button className={cn("inset-drawer__trigger", !hasBody && "cursor-default")} disabled={!hasBody}>
						<ChevronRight
							className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")}
						/>
						<StatusIcon status={toolCall.status} />
						<span className="min-w-0 flex-1 truncate text-left font-mono text-[11px] font-medium text-foreground">
							{toolCall.toolName}
						</span>
						{resultSummary ? (
							<span className="shrink-0 truncate font-mono text-[10px] text-muted-foreground max-w-64">
								{resultSummary}
							</span>
						) : (
							<span className="shrink-0 truncate font-mono text-[10px] text-muted-foreground max-w-32">
								{argsPreview || "no args"}
							</span>
						)}
						<Badge variant={statusVariant as any} className="h-5 shrink-0 rounded px-1.5 font-mono text-[9px]">
							{toolCall.status}
						</Badge>
					</button>
				</CollapsibleTrigger>

				{hasBody && (
					<CollapsibleContent>
						<div className="inset-drawer__content">
							<div className="flex flex-col gap-3 text-[10px] leading-relaxed">
								<section className="flex flex-col gap-1">
									<span className="inset-drawer__label text-foreground">Arguments</span>
									<pre className="whitespace-pre-wrap break-all text-muted-foreground">{argsJson || "{}"}</pre>
								</section>
								{toolCall.result && (
									<section className="flex flex-col gap-1">
										<span className="inset-drawer__label text-foreground">
											{toolCall.isError ? "Error" : "Result"}
											{resultTooLong && (
												<span className="ml-1 text-[9px] text-muted-foreground">
													（{toolCall.result.length} 字符）
												</span>
											)}
										</span>
										<pre
											className={cn(
												"whitespace-pre-wrap break-words max-h-64 overflow-y-auto",
												toolCall.isError ? "text-destructive" : "text-muted-foreground",
											)}
										>
											{toolCall.result}
										</pre>
									</section>
								)}
							</div>
						</div>
					</CollapsibleContent>
				)}
			</div>
		</Collapsible>
	);
}

function StatusIcon({ status }: { status: ToolCallRecord["status"] }) {
	const cls = "size-3.5 shrink-0";
	if (status === "success") return <Check className={cn(cls, "text-emerald-400")} />;
	if (status === "error") return <X className={cn(cls, "text-red-400")} />;
	if (status === "running") return <Loader2 className={cn(cls, "animate-spin text-amber-400")} />;
	return <Wrench className={cn(cls, "text-muted-foreground")} />;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value ?? {}, null, 2);
	} catch {
		return String(value);
	}
}
