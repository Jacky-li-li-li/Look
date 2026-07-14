// ============================================================
// CollapsibleExecutionGroup — collapses a run of consecutive
// thinking + tool blocks into a single "executed N tools" badge.
// Auto-open is disabled; user clicks to expand/collapse manually.
// The badge title shows real-time tool/thinking counts.
// ============================================================

import type { ThinkingContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { cn } from "@shared/lib/utils";
import type { LookUiToolExecState } from "@shared/types";
import { Brain, ChevronRight, Wrench } from "lucide-react";
import React from "react";
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
	const { kind, thinkingCount, toolCount } = React.useMemo(() => classify(blocks), [blocks]);

	const [expanded, setExpanded] = React.useState(false);

	const isOpen = expanded;

	const handleBadgeClick = React.useCallback(() => {
		setExpanded((prev) => !prev);
	}, []);

	const handleBadgeKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			setExpanded((prev) => !prev);
		}
	}, []);

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
				kind={kind}
				isOpen={isOpen}
				thinkingCount={thinkingCount}
				toolCount={toolCount}
				onClick={handleBadgeClick}
				onKeyDown={handleBadgeKeyDown}
			/>
			<div
				data-execution-group-body=""
				data-open={isOpen}
				aria-hidden={!isOpen}
				className="grid"
				style={{
					gridTemplateRows: isOpen ? "1fr" : "0fr",
					opacity: isOpen ? 1 : 0,
					transition: "grid-template-rows 380ms cubic-bezier(0.0, 0.0, 0.2, 1), opacity 320ms ease",
					pointerEvents: isOpen ? undefined : "none",
				}}
			>
				<div className="overflow-hidden">
					<div className="flex flex-col">
						{interleaved.map((node, i) =>
							node.kind === "text" ? (
								<div
									key={`note-${hashKey(node.text)}`}
									data-tool-group-item=""
									className="message-prose text-[10px] text-muted-foreground"
									style={{ animationDelay: `${i * 50}ms` }}
								>
									<SkillAwareContent content={node.text} isStreaming={isStreaming} />
								</div>
							) : (
								<div
									key={node.kind === "block" ? `item-${node.index}` : `node-${i}`}
									data-tool-group-item=""
									style={{ animationDelay: `${i * 50}ms` }}
								>
									{renderBlock(node.block, node.index, toolExecutions, toolResultMap, isStreaming)}
								</div>
							),
						)}
					</div>
				</div>
			</div>
		</div>
	);
});

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
	kind: GroupKind;
	isOpen: boolean;
	thinkingCount: number;
	toolCount: number;
	onClick: () => void;
	onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
}

function RollingNumber({ value }: { value: number }) {
	return (
		<span className="inline-flex overflow-hidden" style={{ height: "1em", lineHeight: 1 }}>
			<span
				key={value}
				className="inline-block animate-[roll-in_220ms_cubic-bezier(0,0,0.2,1)_both]"
				style={{ animationFillMode: "both" }}
			>
				{value}
			</span>
		</span>
	);
}

function buildLabel(kind: GroupKind, thinkingCount: number, toolCount: number): React.ReactNode {
	if (kind === "mixed") {
		return (
			<span>
				Thought <RollingNumber value={thinkingCount} /> / <RollingNumber value={toolCount} /> tools
			</span>
		);
	}
	if (kind === "thinking") {
		return (
			<span>
				Thought <RollingNumber value={thinkingCount} /> time{thinkingCount !== 1 ? "s" : ""}
			</span>
		);
	}
	return (
		<span>
			Executed <RollingNumber value={toolCount} /> tool{toolCount !== 1 ? "s" : ""}
		</span>
	);
}

function BadgeTrigger({ kind, isOpen, thinkingCount, toolCount, onClick, onKeyDown }: BadgeTriggerProps) {
	const Icon = kind === "thinking" ? Brain : Wrench;
	const chevron = (
		<ChevronRight className={cn("size-3 shrink-0 transition-transform duration-150", isOpen && "rotate-90")} />
	);

	return (
		<button
			type="button"
			onClick={onClick}
			onKeyDown={onKeyDown}
			aria-expanded={isOpen}
			className={cn(
				"flex w-full cursor-pointer items-center gap-1.5 py-0.5 pr-2 text-left outline-none",
				"text-[10px] hover:text-foreground transition-colors",
				isOpen ? "text-foreground" : "text-muted-foreground",
			)}
		>
			{chevron}
			<Icon className="size-3.5 shrink-0 text-muted-foreground" />
			<span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] tracking-wide text-muted-foreground">
				{buildLabel(kind, thinkingCount, toolCount)}
			</span>
		</button>
	);
}

export default CollapsibleExecutionGroup;
