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
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Bot } from "lucide-react";
import { activeAgentIdAtom, subagentProgressAtomFamily } from "../store/atoms";
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

	const subagentProgress = useAtomValue(subagentProgressAtomFamily(agentId));
	const [subProgressExpanded, setSubProgressExpanded] = useState(false);

	const runningCount = subagentProgress.filter((e) => e.status === "running").length;
	const doneCount = subagentProgress.filter((e) => e.status === "completed").length;
	const failedCount = subagentProgress.filter((e) => e.status === "failed" || e.status === "aborted").length;

	// 新子 Agent 启动时自动展开
	useEffect(() => {
		if (runningCount > 0) setSubProgressExpanded(true);
	}, [runningCount]);

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
			{subagentProgress.length > 0 && (
				<div className="shrink-0 px-1 pb-1">
					<button
						type="button"
						onClick={() => setSubProgressExpanded(!subProgressExpanded)}
						className="mx-4 flex items-center gap-2 rounded-lg border border-hairline bg-card/30 px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-card/50"
					>
						<Bot className="size-3.5 shrink-0 text-sky-500" />
						<span className="font-medium">{subagentProgress.length} 个 SubAgent</span>
						<span className="text-[10px] text-muted-foreground">
							{runningCount > 0 && `${runningCount} 执行中`}
							{doneCount > 0 && `${runningCount > 0 ? ", " : ""}${doneCount} 已完成`}
							{failedCount > 0 && `, ${failedCount} 失败`}
						</span>
						<span className="ml-auto text-[10px] text-muted-foreground/50">
							{subProgressExpanded ? "收起" : "展开"}
						</span>
					</button>
					{subProgressExpanded && (
						<div className="space-y-1 px-3 pt-1 pb-1">
							{subagentProgress.map((entry) => (
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
