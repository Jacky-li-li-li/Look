// ============================================================
// CollapsibleExecutionGroup — collapses a run of consecutive
// thinking + tool blocks into a single "executed N tools" badge
// once everything has finished streaming. While any block is
// still running, renders the underlying cards in full so live
// progress stays visible.
//
// State machine:
//   - isStreaming && anyRunning       → expanded (live cards)
//   - active group / running tool      → expanded (live cards)
//   - completed active group           → delayed collapse to badge
//   - manual open                      → expanded (user inspection)
//
// Reuses ToolCallCard + ThinkingPanel + scheduleCollapse()
// rather than re-implementing their per-card collapse logic.
// ============================================================

import type { ThinkingContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { cn } from "@shared/lib/utils";
import type { LookUiToolExecState } from "@shared/types";
import { Brain, ChevronRight, Wrench } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { scheduleCollapse } from "../../lib/batchCollapse";
import { hashKey } from "../../lib/stableKey";
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

	const { kind, thinkingCount, toolCount } = React.useMemo(() => classify(blocks), [blocks]);

	const anyRunning = React.useMemo(
		() => blocks.some((b) => isBlockRunning(b, toolExecutions, toolResultMap)),
		[blocks, toolExecutions, toolResultMap],
	);

	const liveOpen = isStreaming || anyRunning;
	const [{ manualOpen, autoOpen }, setGroupState] = React.useState<{
		manualOpen: boolean | null;
		autoOpen: boolean;
	}>(() => ({ manualOpen: null, autoOpen: liveOpen }));
	const prevLiveOpenRef = React.useRef(liveOpen);
	const cancelCollapseRef = React.useRef<(() => void) | null>(null);

	React.useEffect(() => {
		const wasLiveOpen = prevLiveOpenRef.current;
		prevLiveOpenRef.current = liveOpen;

		cancelCollapseRef.current?.();
		cancelCollapseRef.current = null;

		if (liveOpen) {
			setGroupState((state) =>
				state.manualOpen === null && state.autoOpen ? state : { manualOpen: null, autoOpen: true },
			);
			return;
		}

		if (wasLiveOpen) {
			cancelCollapseRef.current = scheduleCollapse(() => {
				setGroupState((state) => (state.manualOpen === null ? { ...state, autoOpen: false } : state));
				cancelCollapseRef.current = null;
			});
			return () => cancelCollapseRef.current?.();
		}

		setGroupState((state) => (state.manualOpen === null && state.autoOpen ? { ...state, autoOpen: false } : state));
	}, [liveOpen]);

	React.useEffect(() => () => cancelCollapseRef.current?.(), []);

	const expanded = manualOpen ?? autoOpen;
	const bodyPresent = useDelayedPresence(expanded, 220);

	const handleBadgeClick = React.useCallback(() => {
		if (liveOpen) return;
		cancelCollapseRef.current?.();
		cancelCollapseRef.current = null;
		// Toggle: clicking the badge when collapsed opens it; clicking when
		// already manually open collapses back to the badge.
		setGroupState((state) => ({ ...state, manualOpen: !(state.manualOpen ?? state.autoOpen) }));
	}, [liveOpen]);

	const handleBadgeKeyDown = React.useCallback(
		(e: React.KeyboardEvent<HTMLButtonElement>) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				if (liveOpen) return;
				cancelCollapseRef.current?.();
				cancelCollapseRef.current = null;
				setGroupState((state) => ({ ...state, manualOpen: !(state.manualOpen ?? state.autoOpen) }));
			}
		},
		[liveOpen],
	);

	// Every group with ≥1 block collapses to a badge — single tool/thinking
	// included, so 1-tool / 1-thinking turns also use the badge form.
	const summary = pickSummary(kind, thinkingCount, toolCount, t);
	const isOpen = expanded;

	// Optional inlineTexts: when provided (e.g. caller wants a note shown
	// alongside the cards), interleave them between blocks. When empty
	// (the default), just render the blocks directly.
	const interleaved = React.useMemo(() => {
		const result: Array<
			{ kind: "text"; text: string } | { kind: "block"; block: ThinkingContent | ToolCall; index: number }
		> = [];
		const textCount = Math.min(inlineTexts.length, blocks.length);
		for (let i = 0; i < blocks.length; i++) {
			if (i < textCount && inlineTexts[i]) {
				result.push({ kind: "text", text: inlineTexts[i] });
			}
			result.push({ kind: "block", block: blocks[i], index: i });
		}
		for (let i = textCount; i < inlineTexts.length; i++) {
			if (inlineTexts[i]) result.push({ kind: "text", text: inlineTexts[i] });
		}
		return result;
	}, [blocks, inlineTexts]);

	if (blocks.length === 0) return null;

	return (
		<div className="flex flex-col" data-execution-group="" data-open={isOpen}>
			<BadgeTrigger
				summary={summary}
				kind={kind}
				isOpen={isOpen}
				disabled={liveOpen}
				onClick={handleBadgeClick}
				onKeyDown={handleBadgeKeyDown}
			/>
			{bodyPresent && (
				<div
					data-execution-group-body=""
					data-open={isOpen}
					aria-hidden={!isOpen}
					className="grid transition-all duration-200 ease-out"
					style={{ gridTemplateRows: isOpen ? "1fr" : "0fr", opacity: isOpen ? 1 : 0 }}
				>
					<div className="overflow-hidden">
						<div className="flex flex-col">
							{interleaved.map((node, i) =>
								node.kind === "text" ? (
									<div
										key={`note-${hashKey(node.text)}`}
										className="message-prose text-[10px] text-muted-foreground"
									>
										<SkillAwareContent content={node.text} isStreaming={isStreaming} />
									</div>
								) : (
									renderBlock(node.block, node.index, toolExecutions, toolResultMap, isStreaming)
								),
							)}
						</div>
					</div>
				</div>
			)}
		</div>
	);
});

function useDelayedPresence(open: boolean, delayMs: number): boolean {
	const [present, setPresent] = React.useState(open);
	React.useEffect(() => {
		if (open) {
			setPresent(true);
			return;
		}
		if (!present) return;
		const timer = setTimeout(() => setPresent(false), delayMs);
		return () => clearTimeout(timer);
	}, [open, delayMs, present]);
	return open || present;
}

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
		const sig = (block as ThinkingContent).thinkingSignature;
		return (
			<ThinkingPanel
				key={sig != null ? `${sig}-${index}` : `thinking-${index}`}
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
			key={block.id || `tool-${block.name}-${hashKey(JSON.stringify(block.arguments ?? {}))}`}
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
	isOpen: boolean;
	disabled?: boolean;
	onClick: () => void;
	onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
}

function BadgeTrigger({ summary, kind, isOpen, disabled, onClick, onKeyDown }: BadgeTriggerProps) {
	const Icon = kind === "thinking" ? Brain : Wrench;
	// Chevron rotates 90° when expanded so the same row visually signals "click to collapse".
	const chevron = (
		<ChevronRight className={cn("size-3 shrink-0 transition-transform duration-150", isOpen && "rotate-90")} />
	);

	return (
		<button
			type="button"
			onClick={onClick}
			onKeyDown={onKeyDown}
			aria-expanded={isOpen}
			aria-disabled={disabled || undefined}
			className={cn(
				"flex w-full items-center gap-2 pr-2.5 py-1 text-left outline-none cursor-pointer",
				"font-mono text-[10px] hover:text-foreground transition-colors",
				disabled && "cursor-default hover:text-muted-foreground",
				isOpen ? "text-foreground" : "text-muted-foreground",
			)}
		>
			{chevron}
			<Icon className="size-3.5 shrink-0 text-muted-foreground" />
			<span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">{summary}</span>
		</button>
	);
}

export default CollapsibleExecutionGroup;
