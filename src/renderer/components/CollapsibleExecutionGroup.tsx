// ============================================================
// CollapsibleExecutionGroup — collapses a run of consecutive
// thinking + tool blocks into a single "executed N tools" badge
// once everything has finished streaming. While any block is
// still running, renders the underlying cards in full so live
// progress stays visible.
//
// State machine:
//   - isStreaming && anyRunning       → expanded (live cards)
//   - allCompleted && !manuallyOpened → collapsed-badge
//   - manuallyOpened                  → expanded (user inspection)
//
// Reuses ToolCallCard + ThinkingPanel + scheduleCollapse()
// rather than re-implementing their per-card collapse logic.
// ============================================================

import type { ThinkingContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Badge } from "@shared/components/ui/badge";
import { cn } from "@shared/lib/utils";
import type { LookUiToolExecState } from "@shared/types";
import { Brain, ChevronRight, Wrench } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { useLookTheme } from "../hooks/useLookTheme";
import { scheduleCollapse } from "../lib/batchCollapse";
import SkillAwareContent from "./SkillAwareContent";
import ThinkingPanel from "./ThinkingPanel";
import ToolCallCard from "./ToolCallCard";

export interface CollapsibleExecutionGroupProps {
	blocks: Array<ThinkingContent | ToolCall>;
	/** Short inline text notes that sit between tool/thinking blocks in the
	 * source order — preserved as visible labels in both collapsed and
	 * expanded states so the reader can still follow the narrative. */
	inlineTexts?: string[];
	toolExecutions: Record<string, LookUiToolExecState>;
	toolResultMap?: Record<string, ToolResultMessage>;
	isStreaming: boolean;
}

type GroupKind = "thinking" | "tools" | "mixed";

function classify(blocks: Array<ThinkingContent | ToolCall>): {
	kind: GroupKind;
	thinkingCount: number;
	toolCount: number;
} {
	let thinkingCount = 0;
	let toolCount = 0;
	for (const b of blocks) {
		if (b.type === "thinking") thinkingCount++;
		else if (b.type === "toolCall") toolCount++;
	}
	let kind: GroupKind;
	if (thinkingCount > 0 && toolCount > 0) kind = "mixed";
	else if (thinkingCount > 0) kind = "thinking";
	else kind = "tools";
	return { kind, thinkingCount, toolCount };
}

function isBlockRunning(
	block: ThinkingContent | ToolCall,
	toolExecutions: Record<string, LookUiToolExecState>,
	toolResultMap: Record<string, ToolResultMessage> | undefined,
): boolean {
	if (block.type === "thinking") return false;
	const execution = toolExecutions[block.id];
	if (execution) return execution.phase === "running";
	const persisted = toolResultMap?.[block.id];
	return !persisted;
}

function statusFor(
	block: ThinkingContent | ToolCall,
	toolExecutions: Record<string, LookUiToolExecState>,
	toolResultMap: Record<string, ToolResultMessage> | undefined,
): "pending" | "running" | "success" | "error" {
	if (block.type === "thinking") return "success";
	const execution = toolExecutions[block.id];
	if (execution) {
		return execution.phase === "running" ? "running" : execution.isError ? "error" : "success";
	}
	const persisted = toolResultMap?.[block.id];
	if (persisted) return persisted.isError ? "error" : "success";
	return "pending";
}

function resultFor(
	block: ThinkingContent | ToolCall,
	toolExecutions: Record<string, LookUiToolExecState>,
	toolResultMap: Record<string, ToolResultMessage> | undefined,
): unknown {
	if (block.type === "thinking") return undefined;
	const execution = toolExecutions[block.id];
	if (execution) {
		return execution.result ?? execution.partialResult;
	}
	const persisted = toolResultMap?.[block.id];
	if (!persisted) return undefined;
	return persisted.content;
}

const CollapsibleExecutionGroup = React.memo(function CollapsibleExecutionGroup({
	blocks,
	inlineTexts = [],
	toolExecutions,
	toolResultMap,
	isStreaming,
}: CollapsibleExecutionGroupProps) {
	const { t } = useTranslation();
	const { style: themeStyle } = useLookTheme();

	const [manuallyOpened, setManuallyOpened] = React.useState(false);

	const { kind, thinkingCount, toolCount } = React.useMemo(() => classify(blocks), [blocks]);

	const anyRunning = React.useMemo(
		() => blocks.some((b) => isBlockRunning(b, toolExecutions, toolResultMap)),
		[blocks, toolExecutions, toolResultMap],
	);

	const allCompleted = !anyRunning;

	// If a new block arrived mid-stream and is still running, force-expand
	// even if the user previously opened the badge and then re-collapsed.
	React.useEffect(() => {
		if (anyRunning) setManuallyOpened(false);
	}, [anyRunning]);

	// While streaming is on, expanded; once it flips off and everything is
	// done, switch back to badge (unless the user is currently inspecting).
	const streamingRef = React.useRef(isStreaming);
	React.useEffect(() => {
		const wasStreaming = streamingRef.current;
		streamingRef.current = isStreaming;
		if (wasStreaming && !isStreaming && allCompleted && !manuallyOpened) {
			// No-op: collapsed-badge is the default rendering path; nothing to do.
		}
	}, [isStreaming, allCompleted, manuallyOpened]);

	const expanded = isStreaming || manuallyOpened || !allCompleted;

	const handleBadgeClick = React.useCallback(() => {
		// Toggle: clicking the badge when collapsed opens it; clicking when
		// already manually open collapses back to the badge.
		setManuallyOpened((prev) => !prev);
	}, []);

	const handleBadgeKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			setManuallyOpened((prev) => !prev);
		}
	}, []);

	if (blocks.length === 0) return null;

	// Every group with ≥1 block collapses to a badge — single tool/thinking
	// included, so 1-tool / 1-thinking turns also use the badge form.
	const summary = pickSummary(kind, thinkingCount, toolCount, t);
	const isOpen = expanded;
	// While streaming is in flight the badge trigger is hidden — the live
	// card list is the source of truth and the badge would just add noise.
	const showTrigger = !isStreaming;

	// Optional inlineTexts: when provided (e.g. caller wants a note shown
	// alongside the cards), interleave them between blocks. When empty
	// (the default), just render the blocks directly.
	const interleaved: Array<
		{ kind: "text"; text: string } | { kind: "block"; block: ThinkingContent | ToolCall; index: number }
	> = [];
	const textCount = Math.min(inlineTexts.length, blocks.length);
	for (let i = 0; i < blocks.length; i++) {
		if (i < textCount && inlineTexts[i]) {
			interleaved.push({ kind: "text", text: inlineTexts[i] });
		}
		interleaved.push({ kind: "block", block: blocks[i], index: i });
	}
	for (let i = textCount; i < inlineTexts.length; i++) {
		if (inlineTexts[i]) interleaved.push({ kind: "text", text: inlineTexts[i] });
	}

	return (
		<div className="flex flex-col gap-1.5">
			{showTrigger && (
				<BadgeTrigger
					summary={summary}
					kind={kind}
					themeStyle={themeStyle}
					isOpen={isOpen}
					onClick={handleBadgeClick}
					onKeyDown={handleBadgeKeyDown}
				/>
			)}
			{isOpen && (
				<div className="flex flex-col gap-1.5">
					{interleaved.map((node, i) =>
						node.kind === "text" ? (
							<div key={`note-${i}`} className="message-prose text-[10px] text-muted-foreground">
								<SkillAwareContent content={node.text} isStreaming={isStreaming} />
							</div>
						) : (
							renderBlock(node.block, node.index, toolExecutions, toolResultMap, isStreaming)
						),
					)}
				</div>
			)}
		</div>
	);
});

function pickSummary(
	kind: GroupKind,
	thinkingCount: number,
	toolCount: number,
	t: (key: string, vars?: Record<string, string | number>) => string,
): string {
	if (kind === "mixed") {
		return t("tool.mixedExecuted", { thinking: thinkingCount, tools: toolCount });
	}
	if (kind === "thinking") {
		return t("tool.thinkingExecuted", { count: thinkingCount });
	}
	return t("tool.executed", { count: toolCount });
}

function renderBlock(
	block: ThinkingContent | ToolCall,
	index: number,
	toolExecutions: Record<string, LookUiToolExecState>,
	toolResultMap: Record<string, ToolResultMessage> | undefined,
	isStreaming: boolean,
): React.ReactNode {
	if (block.type === "thinking") {
		return (
			<ThinkingPanel
				key={`group-thinking-${index}-${(block as ThinkingContent).thinking?.slice(0, 16) ?? ""}`}
				thinking={block.thinking}
				isStreaming={isStreaming}
				autoCollapse={true}
			/>
		);
	}
	const status = statusFor(block, toolExecutions, toolResultMap);
	const result = resultFor(block, toolExecutions, toolResultMap);
	const isError = status === "error";
	return (
		<ToolCallCard
			key={`group-tool-${index}-${block.id}`}
			toolCall={{
				callId: block.id,
				toolName: block.name,
				args: block.arguments,
				status,
				result,
				isError,
			}}
		/>
	);
}

interface BadgeTriggerProps {
	summary: string;
	kind: GroupKind;
	themeStyle: "swiss" | "bauhaus" | "ink-wash";
	isOpen: boolean;
	onClick: () => void;
	onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
}

function BadgeTrigger({ summary, kind, themeStyle, isOpen, onClick, onKeyDown }: BadgeTriggerProps) {
	const Icon = kind === "thinking" ? Brain : Wrench;
	// Chevron rotates 90° when expanded so the same row visually signals "click to collapse".
	const chevron = (
		<ChevronRight className={cn("size-3 shrink-0 transition-transform duration-150", isOpen && "rotate-90")} />
	);

	if (themeStyle === "swiss") {
		return (
			<button
				type="button"
				onClick={onClick}
				onKeyDown={onKeyDown}
				aria-expanded={isOpen}
				className={cn(
					"group inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] transition-opacity",
					isOpen
						? "bg-background text-foreground ring-1 ring-foreground"
						: "bg-foreground text-background hover:opacity-80",
				)}
				style={{ borderRadius: 0 }}
			>
				<Icon className="size-3" />
				<span className="font-sans">{summary}</span>
				{chevron}
			</button>
		);
	}

	if (themeStyle === "bauhaus") {
		return (
			<button
				type="button"
				onClick={onClick}
				onKeyDown={onKeyDown}
				aria-expanded={isOpen}
				className={cn(
					"inline-flex items-center gap-1.5 border-2 border-foreground px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.04em] transition-colors",
					isOpen
						? "bg-foreground text-background"
						: "bg-background text-foreground hover:bg-foreground hover:text-background",
				)}
				style={{ borderRadius: 0 }}
			>
				<span className="inline-block size-2.5" style={{ background: "#fbc02d" }} />
				<Icon className="size-3" />
				<span className="font-display">{summary}</span>
				{chevron}
			</button>
		);
	}

	// ink-wash (default)
	return (
		<button
			type="button"
			onClick={onClick}
			onKeyDown={onKeyDown}
			aria-expanded={isOpen}
			className={cn(
				"inset-drawer__trigger cursor-pointer",
				"font-mono text-[10px] hover:text-foreground",
				isOpen ? "text-foreground" : "text-muted-foreground",
			)}
		>
			{chevron}
			<Icon className="size-3.5 shrink-0 text-muted-foreground" />
			<Badge variant="outline" className="h-5 rounded px-1.5 font-mono text-[9px]">
				{summary}
			</Badge>
		</button>
	);
}

// Schedule a collapse — currently unused but kept so future tweaks can
// reuse the same debounced batcher that ToolCallCard uses.
export const _internal = { scheduleCollapse };

export default CollapsibleExecutionGroup;
