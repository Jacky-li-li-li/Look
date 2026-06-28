// ============================================================
// ToolCallCard — Inset Drawer (Ink Wash, shadcn/ui)
// Auto-expands while a tool is running, auto-collapses on
// completion. Manual toggle overrides until next status change.
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { cn } from "@shared/lib/utils";
import type { ImageContent } from "@shared/types";
import { Check, ChevronRight, Loader2, Wrench, X } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { useLookTheme } from "../hooks/useLookTheme";
import { scheduleCollapse } from "../lib/batchCollapse";
import { linkifyText } from "../lib/linkify";

export interface ToolCallViewModel {
	callId: string;
	toolName: string;
	args: Record<string, unknown>;
	result?: unknown;
	isError?: boolean;
	status: "pending" | "running" | "success" | "error";
}

interface ToolCallCardProps {
	toolCall: ToolCallViewModel;
}

/** Threshold: tool result text longer than this shows a summary + "show more" button */
const RESULT_SUMMARY_LIMIT = 500;

/** Home dir injected by preload — used to shorten absolute paths to ~/…. */
const HOME_DIR = typeof window !== "undefined" ? (window.look?.homedir ?? "") : "";

/**
 * Extract text and images from a tool execution result.
 * SDK may return raw objects like { content: [...], details: ... } or
 * plain strings. This mirrors the SDK's ToolResultMessage.content format
 * but preserves image blocks alongside text.
 */
function extractToolResult(value: unknown): { text: string; images: ImageContent[] } {
	if (value === undefined || value === null) return { text: "", images: [] };
	if (typeof value === "string") return { text: value, images: [] };
	if (typeof value === "object" && "content" in value && Array.isArray((value as any).content)) {
		const textParts: string[] = [];
		const images: ImageContent[] = [];
		for (const block of (value as any).content) {
			if (block?.type === "text" && typeof block.text === "string") {
				textParts.push(block.text);
			} else if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
				images.push({ type: "image", data: block.data, mimeType: block.mimeType });
			}
		}
		return { text: textParts.join("\n"), images };
	}
	try {
		return { text: JSON.stringify(value, null, 2), images: [] };
	} catch {
		const str = String(value);
		if (str !== "[object Object]") return { text: str, images: [] };
		return {
			text:
				typeof value === "object" && value !== null
					? `[${Object.getPrototypeOf(value)?.constructor?.name ?? "Object"}]`
					: str,
			images: [],
		};
	}
}

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
function formatToolSummary(toolCall: ToolCallViewModel): string {
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
	toolCall: ToolCallViewModel,
	t: (key: string, vars?: Record<string, string | number>) => string,
): string {
	const { toolName, result, status } = toolCall;
	if (status !== "success" || !result) return "";
	const { text } = extractToolResult(result);
	if (!text) return "";
	const trimmed = text.trim();
	switch (toolName) {
		case "bash":
			return ` · ${t("tool.statLines", { n: text.split("\n").length })}`;
		case "read": {
			const bytes = text.length;
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
	const { style: themeStyle } = useLookTheme();
	// Auto open when running, auto close on completion
	const [open, setOpen] = React.useState(toolCall.status === "running");
	const prevStatus = React.useRef(toolCall.status);
	const userManuallyToggled = React.useRef(false);
	const cancelCollapseRef = React.useRef<(() => void) | null>(null);

	// Track status transitions for auto-expand/collapse
	React.useEffect(() => {
		const prev = prevStatus.current;
		const curr = toolCall.status;

		if (prev !== curr) {
			if (curr === "running") {
				// Auto-expand when tool starts running, reset manual override
				// and cancel any pending collapse from a previous completion.
				cancelCollapseRef.current?.();
				cancelCollapseRef.current = null;
				userManuallyToggled.current = false;
				setOpen(true);
			} else if ((curr === "success" || curr === "error") && !userManuallyToggled.current) {
				// Cancel previous collapse before scheduling a new one
				// (e.g. tool cycled success→running→success within 300ms).
				cancelCollapseRef.current?.();
				cancelCollapseRef.current = scheduleCollapse(() => setOpen(false));
			}
			prevStatus.current = curr;
		}
	}, [toolCall.status]);

	// Clean up pending collapse on unmount.
	React.useEffect(() => () => cancelCollapseRef.current?.(), []);

	const argsJson = React.useMemo(() => safeJson(toolCall.args), [toolCall.args]);
	const argsPreview = argsJson.slice(0, 80);
	const extracted = React.useMemo(() => extractToolResult(toolCall.result), [toolCall.result]);
	const resultStr = extracted.text;
	const resultImages = extracted.images;
	const hasBody = resultStr.length > 0 || resultImages.length > 0 || argsPreview.length > 0;

	const toolSummary = formatToolSummary(toolCall);
	const statSuffix = !open ? formatStatSuffix(toolCall, t) : "";
	const resultTooLong = resultStr.length > RESULT_SUMMARY_LIMIT;

	const statusVariant =
		toolCall.status === "success" ? "outline" : toolCall.status === "error" ? "destructive" : "secondary";
	const statusBadgeColor =
		toolCall.status === "success"
			? "text-emerald-500"
			: toolCall.status === "error"
				? "text-red-500"
				: toolCall.status === "running"
					? "text-amber-500"
					: "text-muted-foreground";

	return (
		<div>
			<div className="inset-drawer">
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
					<ChevronRight className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")} />
					<StatusIcon status={toolCall.status} />
					<span
						className={cn(
							"shrink-0 font-medium text-foreground",
							themeStyle === "swiss" && "font-sans text-[10px] uppercase tracking-[0.08em] font-bold",
							themeStyle === "bauhaus" && "font-display text-[11px] uppercase tracking-[0.04em]",
							themeStyle === "ink-wash" && "font-mono text-[11px]",
						)}
					>
						{toolCall.toolName}
					</span>
					<span className="min-w-0 flex-1 truncate text-left font-mono text-[10px] text-muted-foreground">
						{toolSummary || argsPreview || t("tool.noArgs")}
					</span>
					{statSuffix && (
						<span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">{statSuffix}</span>
					)}
					{themeStyle === "swiss" ? (
						<span
							className="ml-auto h-5 shrink-0 px-1.5 font-mono text-[9px] font-bold uppercase tracking-wider inline-flex items-center bg-foreground text-background"
							style={{ borderRadius: 0 }}
						>
							{toolCall.status}
						</span>
					) : themeStyle === "bauhaus" ? (
						<span className="ml-auto inline-flex items-center gap-1">
							<span
								className="inline-block size-2.5"
								style={{
									background:
										toolCall.status === "success"
											? "#1976d2"
											: toolCall.status === "error"
												? "#e2231a"
												: toolCall.status === "running"
													? "#fbc02d"
													: "var(--muted-foreground)",
									borderRadius: 0,
								}}
							/>
							<span className="font-display text-[9px] uppercase tracking-[0.06em] font-bold text-foreground">
								{toolCall.status}
							</span>
						</span>
					) : (
						<Badge
							variant={statusVariant as any}
							className={cn("h-5 shrink-0 rounded px-1.5 font-mono text-[9px]", statusBadgeColor)}
						>
							{toolCall.status}
						</Badge>
					)}
				</button>

				{hasBody && (
					<div
						className="grid transition-all duration-200 ease-out"
						style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
					>
						<div className="overflow-hidden">
							<div className="inset-drawer__content">
								<div className="flex flex-col gap-2 text-[10px] leading-relaxed">
									<section className="flex flex-col gap-1">
										<span className="inset-drawer__label text-foreground">{t("tool.arguments")}</span>
										<pre className="whitespace-pre-wrap break-all text-muted-foreground">
											{argsJson || "{}"}
										</pre>
									</section>
									{resultStr && (
										<section className="flex flex-col gap-1">
											<span className="inset-drawer__label text-foreground">
												{toolCall.isError ? t("tool.error") : t("tool.result")}
												{resultTooLong && (
													<span className="ml-1 text-[9px] text-muted-foreground">
														({resultStr.length} 字符)
													</span>
												)}
											</span>
												<div
												className={cn(
													"whitespace-pre-wrap break-words max-h-64 overflow-y-auto font-mono text-[10px]",
													toolCall.isError ? "text-destructive" : "text-muted-foreground",
												)}
											>
												{linkifyText(resultStr)}
											</div>
										</section>
									)}
									{resultImages.length > 0 && (
										<section className="flex flex-col gap-1">
											<span className="inset-drawer__label text-foreground">
												{t("tool.result")}
											</span>
											<div className="flex flex-wrap gap-2">
												{resultImages.map((img, i) => (
													<img
														key={`result-img-${i}`}
														src={`data:${img.mimeType};base64,${img.data}`}
														alt={`Tool result image ${i + 1}`}
														className="max-h-48 max-w-64 rounded-md border border-hairline object-contain"
													/>
												))}
											</div>
										</section>
									)}
								</div>
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

function StatusIcon({ status }: { status: ToolCallViewModel["status"] }) {
	if (status === "success")
		return (
			<span className="text-emerald-500">
				<Check className="size-3.5 shrink-0" />
			</span>
		);
	if (status === "error")
		return (
			<span className="text-red-500">
				<X className="size-3.5 shrink-0" />
			</span>
		);
	if (status === "running")
		return (
			<span className="text-amber-500">
				<Loader2 className="size-3.5 shrink-0 animate-spin" />
			</span>
		);
	return (
		<span className="text-muted-foreground">
			<Wrench className="size-3.5 shrink-0 animate-pulse" />
		</span>
	);
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
	return a.callId === b.callId && a.status === b.status && a.isError === b.isError && a.result === b.result;
});
