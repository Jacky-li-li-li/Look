// ============================================================
// ChatPanel — Whisper Bubbles + Line Input (Ink Wash, shadcn/ui)
//
// Thin orchestrator: composes ChatMessageList, ChatQueueDrawer,
// and ChatInput. All message merging, scroll/branch/copy logic
// lives in ChatMessageList; all input/skill/slash state lives
// in ChatInput.
// ============================================================

import type { ImageContent, ThinkingLevel } from "@shared/types";
import { useAtomValue } from "jotai";
import { Bot } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	activeAgentIdAtom,
	type SubagentProgressEntry,
	subagentProgressAtomFamily,
	subSessionsAtomFamily,
} from "../store/atoms";
import { appStore } from "../store/ipcHandler";
import type { RendererSessionPhase, RendererSessionState } from "../store/sessionTypes";
import ChatInput, { type ChatInputHandle } from "./ChatInput";
import ChatMessageList from "./ChatMessageList";
import ChatQueueDrawer from "./ChatQueueDrawer";
import SubagentProgressCard from "./SubagentProgressCard";

interface ChatPanelProps {
	agentId: string;
	agentName?: string;
	sessionState: RendererSessionState;
	autoCollapse: boolean;
	queue: { steering: string[]; followUp: string[] };
	phase: RendererSessionPhase;
	currentModel: string;
	currentThinking: string;
	availableThinkingLevels?: ThinkingLevel[];
	onSend: (text: string, images?: ImageContent[]) => Promise<boolean>;
	onThinkingChange: (level: string) => void;
	onModelChange: (model: string) => void;
	onRequestApiKeys?: () => void;
	onAbort?: () => void;
}

export { ScrollToBottomButton } from "./ChatMessageList";

const ChatPanel = memo(function ChatPanel({
	agentId,
	agentName,
	sessionState,
	autoCollapse,
	queue,
	phase,
	currentModel,
	currentThinking,
	availableThinkingLevels,
	onSend,
	onThinkingChange,
	onModelChange,
	onRequestApiKeys,
	onAbort,
}: ChatPanelProps) {
	const inputRef = useRef<ChatInputHandle>(null);

	const isBusy = phase !== "idle";

	const handleAbort = useCallback(() => {
		onAbort?.();
	}, [onAbort]);

	const _subagentProgress = useAtomValue(subagentProgressAtomFamily(agentId));
	const [subProgressExpanded, setSubProgressExpanded] = useState(false);

	// 合并实时进度事件 + 已持久化/已完成的子会话（重启后不丢失）
	const childSessions = useAtomValue(subSessionsAtomFamily(agentId));
	const mergedProgress = useMemo(() => {
		const fromEvents = new Map(_subagentProgress.map((e: SubagentProgressEntry) => [e.childSessionId, e]));
		// 已持久化的子会话（不在事件列表中），作为 completed entry 补充
		for (const child of childSessions) {
			if (!fromEvents.has(child.id)) {
				fromEvents.set(child.id, {
					childSessionId: child.id,
					agentName: child.name,
					status: child.isStreaming ? "running" : "completed",
				});
			}
		}
		return Array.from(fromEvents.values());
	}, [_subagentProgress, childSessions]);

	const runningCount = mergedProgress.filter((e) => e.status === "running").length;
	const doneCount = mergedProgress.filter((e) => e.status === "completed").length;
	const failedCount = mergedProgress.filter((e) => e.status === "failed" || e.status === "aborted").length;

	// 新子 Agent 启动时自动展开，全部完成后自动折叠
	useEffect(() => {
		if (runningCount > 0) {
			setSubProgressExpanded(true);
		} else if (doneCount + failedCount > 0) {
			// 有完成的子 Agent 且没有运行中的 → 全部结束 → 折叠
			setSubProgressExpanded(false);
		}
	}, [runningCount, doneCount, failedCount]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<ChatMessageList
				agentId={agentId}
				agentName={agentName}
				sessionState={sessionState}
				autoCollapse={autoCollapse}
				phase={phase}
				isBusy={isBusy}
				inputRef={inputRef}
				onSend={onSend}
			/>
			{/* Stage 5：子 Agent 进度卡片（可折叠） */}
			{mergedProgress.length > 0 && (
				<div className="shrink-0 px-3 pb-1">
					<button
						type="button"
						onClick={() => setSubProgressExpanded(!subProgressExpanded)}
						className="flex w-full items-center gap-2 rounded-lg border border-hairline bg-card/30 px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-card/50"
					>
						<Bot className="size-3.5 shrink-0 text-sky-500" />
						<span className="font-medium">
							{runningCount > 0
								? `${runningCount} 执行中${doneCount > 0 ? ` · ${doneCount} 已完成` : ""}${failedCount > 0 ? ` · ${failedCount} 失败` : ""}`
								: `${doneCount + failedCount} 个 SubAgent 已完成`}
						</span>
						<span className="ml-auto text-[10px] text-muted-foreground/50">
							{subProgressExpanded ? "收起" : "展开"}
						</span>
					</button>
					{subProgressExpanded && (
						<div className="space-y-1 pt-1 pb-1">
							{mergedProgress.map((entry) => (
								<SubagentProgressCard
									key={entry.childSessionId}
									entry={entry}
									onClick={() => appStore.set(activeAgentIdAtom, entry.childSessionId)}
								/>
							))}
						</div>
					)}
				</div>
			)}
			<ChatQueueDrawer queue={queue} />
			<ChatInput
				ref={inputRef}
				agentId={agentId}
				currentModel={currentModel}
				currentThinking={currentThinking}
				availableThinkingLevels={availableThinkingLevels}
				isBusy={isBusy}
				onSend={onSend}
				onThinkingChange={onThinkingChange}
				onModelChange={onModelChange}
				onRequestApiKeys={onRequestApiKeys}
				onAbort={handleAbort}
			/>
		</div>
	);
});

export default ChatPanel;
