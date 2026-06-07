// ============================================================
// ToolCallCard — Inset Drawer (Ink Wash, shadcn/ui)
// Auto-expands while a tool is running, auto-collapses on
// completion. Manual toggle overrides until next status change.
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@shared/components/ui/collapsible";
import { cn } from "@shared/lib/utils";
import type { ToolCallRecord } from "@shared/types";
import { Check, ChevronRight, Loader2, Wrench, X } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

interface ToolCallCardProps {
	toolCall: ToolCallRecord;
}

/** Threshold: tool result text longer than this shows a summary + "show more" button */
const RESULT_SUMMARY_LIMIT = 500;

/** Home dir injected by preload — used to shorten absolute paths to ~/…. */
const HOME_DIR = typeof window !== "undefined" ? (window.look?.homedir ?? "") : "";

function shortenPath(p: string): string {
	if (!p) return p;
	if (HOME_DIR && (p === HOME_DIR || p.startsWith(`${HOME_DIR}/`))) {
		return `~${p.slice(HOME_DIR.length)}`;
	}
	return p;
}

function argStr(args: Record<string, unknown>, ...keys: string[]): string {
	for (const k of keys) {
		const v = args?.[k];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return "";
}

/**
 * The title-row summary for a tool call. Mirrors pi sdk's `renderCall`:
 * "tool name + primary args" (command / path / pattern), NOT a line/char
 * count. Built from `args`, so it is available in every status
 * (pending/running/success/error). Returns "" to fall back to argsPreview.
 */
function formatToolSummary(toolCall: ToolCallRecord): string {
	const a = toolCall.args ?? {};
	switch (toolCall.toolName) {
		case "bash": {
			const cmd = argStr(a, "command").replace(/\s+/g, " ").trim();
			const timeout = typeof a.timeout === "number" ? ` (timeout ${a.timeout}s)` : "";
			return cmd ? `$ ${cmd}${timeout}` : "$ …";
		}
		case "read": {
			const p = shortenPath(argStr(a, "path", "file_path"));
			const offset = typeof a.offset === "number" ? a.offset : undefined;
			const limit = typeof a.limit === "number" ? a.limit : undefined;
			const range = offset !== undefined ? `:${offset}${limit !== undefined ? `-${offset + limit - 1}` : ""}` : "";
			return `${p}${range}`;
		}
		case "write":
		case "edit":
			return shortenPath(argStr(a, "path", "file_path"));
		case "grep": {
			const pattern = argStr(a, "pattern");
			const inPath = shortenPath(argStr(a, "path")) || ".";
			const glob = argStr(a, "glob") ? ` (${argStr(a, "glob")})` : "";
			return `/${pattern}/ in ${inPath}${glob}`;
		}
		case "ls":
			return shortenPath(argStr(a, "path")) || ".";
		case "find": {
			const pattern = argStr(a, "pattern");
			const inPath = shortenPath(argStr(a, "path")) || ".";
			return `${pattern} in ${inPath}`;
		}
		default:
			return "";
	}
}

/**
 * A compact result-stat suffix shown only after success (collapsed view
 * can't see the result body, so we surface a tiny stat in the title).
 * Returns "" when there is nothing meaningful to show.
 */
function formatStatSuffix(
	toolCall: ToolCallRecord,
	t: (key: string, vars?: Record<string, string | number>) => string,
): string {
	const { toolName, result, status } = toolCall;
	if (status !== "success" || !result) return "";
	const trimmed = result.trim();
	switch (toolName) {
		case "bash":
			return ` · ${t("tool.statLines", { n: result.split("\n").length })}`;
		case "read": {
			const bytes = result.length;
			return ` · ${bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`}`;
		}
		case "grep": {
			const n = !trimmed || trimmed === "No matches found" ? 0 : trimmed.split("\n").length;
			return ` · ${t("tool.statMatches", { n })}`;
		}
		case "ls":
			return ` · ${t("tool.statEntries", { n: trimmed ? trimmed.split("\n").length : 0 })}`;
		default:
			return "";
	}
}

function ToolCallCard({ toolCall }: ToolCallCardProps) {
	const { t } = useTranslation();
	// Auto open when running, auto close on completion
	const [open, setOpen] = React.useState(toolCall.status === "running");
	const prevStatus = React.useRef(toolCall.status);
	const userManuallyToggled = React.useRef(false);
	const collapseTimerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined as any);

	// Track status transitions for auto-expand/collapse
	React.useEffect(() => {
		const prev = prevStatus.current;
		const curr = toolCall.status;

		if (prev !== curr) {
			if (curr === "running") {
				// Auto-expand when tool starts running, reset manual override
				if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
				userManuallyToggled.current = false;
				setOpen(true);
			} else if ((curr === "success" || curr === "error") && !userManuallyToggled.current) {
				// Debounce auto-collapse by 300ms so rapid status transitions
				// don't trigger animation thrashing. Collects multiple tool
				// completions into a single frame.
				collapseTimerRef.current = setTimeout(() => setOpen(false), 300);
				return () => { if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current); };
			}
			prevStatus.current = curr;
		}
	}, [toolCall.status]);

	const argsJson = safeJson(toolCall.args);
	const argsPreview = argsJson.slice(0, 80);
	const hasBody = (toolCall.result && toolCall.result.length > 0) || argsPreview.length > 0;

	const toolSummary = formatToolSummary(toolCall);
	const statSuffix = !open ? formatStatSuffix(toolCall, t) : "";
	const resultTooLong = toolCall.result ? toolCall.result.length > RESULT_SUMMARY_LIMIT : false;

	const statusVariant =
		toolCall.status === "success" ? "outline" : toolCall.status === "error" ? "destructive" : "secondary";

	return (
		<Collapsible open={open}>
			<div className="inset-drawer">
				<CollapsibleTrigger asChild>
					<button
						className={cn("inset-drawer__trigger", !hasBody && "cursor-default")}
						disabled={!hasBody}
						onClick={() => {
							if (hasBody) {
								userManuallyToggled.current = true;
								setOpen((v) => !v);
							}
						}}
					>
						<ChevronRight
							className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")}
						/>
						<StatusIcon status={toolCall.status} />
						<span className="shrink-0 font-mono text-[11px] font-medium text-foreground">
							{toolCall.toolName}
						</span>
						<span className="min-w-0 flex-1 truncate text-left font-mono text-[10px] text-muted-foreground">
							{toolSummary || argsPreview || t("tool.noArgs")}
						</span>
						{statSuffix && (
							<span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">{statSuffix}</span>
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
									<span className="inset-drawer__label text-foreground">{t("tool.arguments")}</span>
									<pre className="whitespace-pre-wrap break-all text-muted-foreground">{argsJson || "{}"}</pre>
								</section>
								{toolCall.result && (
									<section className="flex flex-col gap-1">
										<span className="inset-drawer__label text-foreground">
											{toolCall.isError ? t("tool.error") : t("tool.result")}
											{resultTooLong && (
												<span className="ml-1 text-[9px] text-muted-foreground">
													({toolCall.result.length} 字符)
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

export default React.memo(ToolCallCard, (prev, next) => {
	const a = prev.toolCall;
	const b = next.toolCall;
	return (
		a.callId === b.callId &&
		a.status === b.status &&
		a.isError === b.isError &&
		a.result === b.result
	);
});
