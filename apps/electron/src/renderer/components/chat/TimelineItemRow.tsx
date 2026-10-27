import type { LookAgentMessage, LookSessionEntry, LookUiToolExecState } from "@shared/types";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { TimelineItem } from "../../lib/timeline";

import { CompactionStatusCard } from "./CompactionStatusCard";
import { MessageItem } from "./MessageItem";
import { MessageActions } from "./message-elements/MessageActions";
import SessionChangesCard from "./SessionChangesCard";
import { SessionEntryBubble } from "./SessionEntryBubble";

/** 模块级空对象常量，避免 JSX 内联 {} 破坏 React.memo */
const EMPTY_TOOL_EXECUTIONS: Record<string, LookUiToolExecState> = {};

export type TurnCardProps = {
	entries: LookSessionEntry[];
	projectCwd?: string;
	turnKey?: string;
};

export type TimelineItemRowProps = {
	item: TimelineItem;
	turnCard?: TurnCardProps;
	agentId: string;
	agentName?: string;
	projectId?: string;
	leafId: string | null;
	isBusy: boolean;
	flashEntryId: string | null;
	copiedEntryId: string | null;
	messageAlignment: "left" | "left-right";
	branchBusy: boolean;
	onBranch?: (entryId: string) => void;
	onFork?: (entryId: string) => void;
	onCopy?: (id: string, message: LookAgentMessage) => void;
};

/**
 * 单条 timeline 渲染：compaction / session entry / MessageItem+actions。
 * 从 ChatMessagesInner.renderTimelineItem 抽出，行为不变。
 */
export const TimelineItemRow = memo(function TimelineItemRow({
	item,
	turnCard,
	agentId,
	agentName,
	projectId,
	leafId,
	isBusy,
	flashEntryId,
	copiedEntryId,
	messageAlignment,
	branchBusy,
	onBranch,
	onFork,
	onCopy,
}: TimelineItemRowProps) {
	const { t } = useTranslation();
	if (!item) return null;

	if (item.compactionPhase) {
		return (
			<CompactionStatusCard
				key={item.id}
				phase={item.compactionPhase}
				summary={item.compactionSummary}
				tokensBefore={item.compactionTokensBefore}
				estimatedTokensAfter={item.compactionEstimatedTokensAfter}
				sessionId={agentId}
			/>
		);
	}

	if (item.entry) {
		return (
			<div key={item.id} className="px-msg-item-x py-msg-item-y">
				<SessionEntryBubble entry={item.entry} />
			</div>
		);
	}

	if (item.message || (item.isLive && item.uiBlocks)) {
		const itemEntryId = item.entryId;
		const actionEntryId = item.secondaryEntryIds?.at(-1) ?? itemEntryId;
		const anchorEntryIds = [item.id, itemEntryId, ...(item.secondaryEntryIds ?? [])].filter((id): id is string =>
			Boolean(id),
		);
		const live = item.isLive;
		return (
			<div key={item.id} className="msg-row px-msg-item-x py-msg-item-y">
				<div
					data-message-id={item.id}
					data-entry-ids={anchorEntryIds.join(" ")}
					className="group/message flex flex-col"
				>
					<MessageItem
						message={item.message}
						entryId={itemEntryId}
						blockCacheKey={
							itemEntryId
								? `${agentId}:${[itemEntryId, ...(item.secondaryEntryIds ?? [])].join("|")}`
								: undefined
						}
						agentName={agentName}
						sessionId={agentId}
						projectId={projectId}
						isStreaming={live ? isBusy : false}
						toolExecutions={EMPTY_TOOL_EXECUTIONS}
						toolResultMap={item.toolResultMap}
						isActiveLeaf={Boolean(actionEntryId && actionEntryId === leafId)}
						flash={flashEntryId === item.id}
						liveBlocks={live ? item.uiBlocks : undefined}
						liveToolExecutions={live ? (item.uiTools ?? EMPTY_TOOL_EXECUTIONS) : EMPTY_TOOL_EXECUTIONS}
					/>
					{turnCard && (
						<div className="flex w-full max-w-[98%] gap-msg-bubble">
							<div className="mt-msg-avatar size-7 shrink-0" aria-hidden="true" />
							<div className="min-w-0 flex-1">
								<SessionChangesCard
									entries={turnCard.entries}
									projectCwd={turnCard.projectCwd}
									agentId={agentId}
									turnKey={turnCard.turnKey}
								/>
							</div>
						</div>
					)}
					<MessageActions
						show={
							!live &&
							Boolean(itemEntryId) &&
							Boolean(item.message) &&
							(item.message?.role === "assistant" || item.message?.role === "user")
						}
						isUser={item.message?.role === "user"}
						alignment={messageAlignment}
						busy={isBusy || branchBusy}
						onBranch={actionEntryId && onBranch ? () => onBranch(actionEntryId) : undefined}
						onFork={
							item.message && item.message.role !== "user" && actionEntryId && onFork
								? () => onFork(actionEntryId)
								: undefined
						}
						onCopy={item.message && onCopy ? () => onCopy(item.id, item.message!) : undefined}
						copied={copiedEntryId === item.id}
						labels={{
							branch: t("chat.branchFromHere"),
							fork: t("chat.forkToNewChat"),
							copy: t("chat.copyMessage"),
						}}
						meta={
							item.message &&
							item.message.role === "assistant" &&
							item.turnDurationMs != null &&
							item.turnDurationMs > 0 ? (
								<span className="font-mono text-[10px] text-muted-foreground/60 tabular-nums">
									{item.turnDurationMs >= 60_000
										? `${(item.turnDurationMs / 60_000).toFixed(1)}m`
										: `${(item.turnDurationMs / 1_000).toFixed(1)}s`}
								</span>
							) : undefined
						}
					/>
				</div>
			</div>
		);
	}

	return null;
});
