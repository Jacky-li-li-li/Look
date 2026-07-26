// ============================================================
// ToolCallCard — Inset Drawer (Ink Wash, shadcn/ui)
// Tool details stay collapsed by default and are controlled manually.
// ============================================================

import { cn } from "@look/ui";
import type { ImageContent } from "@shared/types";
import {
	Bot,
	Brain,
	ChevronRight,
	Code2,
	FileSearch,
	FileText,
	Folder,
	Globe,
	Pencil,
	Search,
	Terminal,
} from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import LookMarkdown from "../markdown/LookMarkdown";

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
interface ToolResultContentBlock {
	type?: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

interface ToolResultValue {
	content?: ToolResultContentBlock[];
}

function extractToolResult(value: unknown): { text: string; images: ImageContent[] } {
	if (value === undefined || value === null) return { text: "", images: [] };
	if (typeof value === "string") return { text: value, images: [] };
	if (typeof value === "object" && "content" in value && Array.isArray((value as ToolResultValue).content)) {
		const textParts: string[] = [];
		const images: ImageContent[] = [];
		for (const block of (value as ToolResultValue).content!) {
			if (block?.type === "text" && typeof block.text === "string") {
				textParts.push(block.text);
			} else if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
				images.push({ type: "image", data: block.data, mimeType: block.mimeType });
			}
		}
		return { text: textParts.join("\n"), images };
	}
	try {
		const json = JSON.stringify(value, null, 2);
		// 包裹在代码块中，防止 markdown 解析器将 JSON 结构解析为异常 AST
		return { text: `\`\`\`json\n${json}\n\`\`\``, images: [] };
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
	const [open, setOpen] = React.useState(false);

	const argsJson = React.useMemo(() => safeJson(toolCall.args), [toolCall.args]);
	const argsPreview = argsJson.slice(0, 80);
	const extracted = React.useMemo(() => extractToolResult(toolCall.result), [toolCall.result]);
	const resultStr = extracted.text;
	const resultImages = extracted.images;
	const hasBody = resultStr.length > 0 || resultImages.length > 0 || argsPreview.length > 0;

	const toolSummary = formatToolSummary(toolCall);
	const statSuffix = !open ? formatStatSuffix(toolCall, t) : "";
	const resultTooLong = resultStr.length > RESULT_SUMMARY_LIMIT;

	const statusBadgeColor =
		toolCall.status === "success"
			? "text-emerald-500 dark:text-emerald-400"
			: toolCall.status === "error"
				? "text-red-500 dark:text-red-400"
				: toolCall.status === "running"
					? "text-amber-500 dark:text-amber-300"
					: "text-muted-foreground";

	return (
		<div data-tool-panel="" data-open={open}>
			<div>
				<button
					data-tool-panel-trigger=""
					type="button"
					aria-expanded={open}
					className={cn(
						"flex w-full items-center gap-1.5 px-2 py-1 text-left outline-none text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors",
						!hasBody && "cursor-default",
					)}
					disabled={!hasBody}
					onClick={() => {
						if (hasBody) {
							setOpen((prev) => !prev);
						}
					}}
				>
					<ChevronRight className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")} />
					<ToolTypeIcon toolName={toolCall.toolName} status={toolCall.status} />
					<span className="shrink-0 font-mono text-[11px] font-medium text-foreground">{toolCall.toolName}</span>
					<span className="min-w-0 flex-1 truncate text-left font-mono text-[10px] text-muted-foreground">
						{toolSummary || argsPreview || t("tool.noArgs")}
					</span>
					{statSuffix && (
						<span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">{statSuffix}</span>
					)}
					<span className={cn("ml-auto shrink-0 font-mono text-[9px] uppercase tracking-wider", statusBadgeColor)}>
						{toolCall.status}
					</span>
				</button>

				{hasBody && (
					<div
						data-tool-panel-body=""
						data-open={open}
						className="grid"
						style={{
							gridTemplateRows: open ? "1fr" : "0fr",
							opacity: open ? 1 : 0,
							transition: "grid-template-rows 380ms cubic-bezier(0.0, 0.0, 0.2, 1), opacity 320ms ease",
						}}
					>
						<div className="overflow-hidden">
							<div className="max-h-72 overflow-auto px-2.5 py-1.5 text-[11px] leading-[1.4] text-muted-foreground">
								<div className="flex flex-col gap-1 text-[10px] leading-[1.4]">
									<section className="flex flex-col gap-0.5">
										<span className="text-[10px] font-semibold uppercase tracking-wide text-foreground">
											{t("tool.arguments")}
										</span>
										<pre className="whitespace-pre-wrap break-all text-[10px] text-muted-foreground">
											{argsJson || "{}"}
										</pre>
									</section>
									{resultStr && (
										<section className="flex flex-col gap-0.5">
											<span className="text-[10px] font-semibold uppercase tracking-wide text-foreground">
												{toolCall.isError ? t("tool.error") : t("tool.result")}
												{resultTooLong && (
													<span className="ml-1 text-[9px] text-muted-foreground">
														({resultStr.length} 字符)
													</span>
												)}
											</span>
											<LookMarkdown content={resultStr} />
										</section>
									)}
									{resultImages.length > 0 && (
										<section className="flex flex-col gap-0.5">
											<span className="text-[10px] font-semibold uppercase tracking-wide text-foreground">
												{t("tool.result")}
											</span>
											<div className="flex flex-wrap gap-2">
												{resultImages.map((img, i) => (
													<img
														key={`result-img-${i}`}
														src={`data:${img.mimeType};base64,${img.data}`}
														alt={`Tool result ${i + 1}`}
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

function ToolTypeIcon({ toolName, status }: { toolName: string; status: ToolCallViewModel["status"] }) {
	const colorClass =
		status === "success"
			? "text-emerald-500 dark:text-emerald-400"
			: status === "error"
				? "text-red-500 dark:text-red-400"
				: status === "running"
					? "text-amber-500 dark:text-amber-300"
					: "text-muted-foreground";
	const spinClass = status === "running" ? "animate-spin" : status === "pending" ? "animate-pulse" : "";
	return (
		<span className={cn(colorClass, "inline-flex")}>
			{pickToolIcon(toolName, cn("size-3.5 shrink-0", spinClass))}
		</span>
	);
}

function pickToolIcon(toolName: string, className?: string): React.ReactElement {
	const name = toolName.toLowerCase();
	const cls = className ?? "size-3.5 shrink-0";
	if (["bash", "terminal", "shell", "sh", "zsh", "python", "node"].includes(name)) return <Terminal className={cls} />;
	if (["read"].includes(name)) return <FileText className={cls} />;
	if (["write", "edit", "apply_diff", "create", "modify"].includes(name)) return <Pencil className={cls} />;
	if (["grep", "search"].includes(name)) return <Search className={cls} />;
	if (["ls", "dir", "list"].includes(name)) return <Folder className={cls} />;
	if (["find", "glob"].includes(name)) return <FileSearch className={cls} />;
	if (["webfetch", "websearch", "curl", "fetch", "web"].includes(name)) return <Globe className={cls} />;
	if (["think", "reason", "brain"].includes(name)) return <Brain className={cls} />;
	if (["agent", "subagent", "subagent_parallel", "subagent_chain", "delegate_agent", "delegate_agents"].includes(name))
		return <Bot className={cls} />;
	return <Code2 className={cls} />;
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
		a.result === b.result &&
		a.args === b.args
	);
});
