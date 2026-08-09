// ============================================================
// ChatPanel — Whisper Bubbles + Line Input (Ink Wash, shadcn/ui)
//
// Thin orchestrator: composes ChatMessageList, ChatQueueDrawer,
// and ChatInput. All message merging, scroll/branch/copy logic
// lives in ChatMessageList; all input/skill/slash state lives
// in ChatInput.
// ============================================================

import type { ImageContent, ThinkingLevel } from "@shared/types";
import { useAtomValue, useSetAtom } from "jotai";
import { memo, useCallback, useMemo, useRef } from "react";
import { activeAgentAtom, autoCollapseAtom, settingsTabAtom, showSettingsAtom } from "../../store/atoms";
import type { RendererSessionPhase, RendererSessionState } from "../../store/sessionTypes";
import PlanQuestionDialog from "../dialogs/PlanQuestionDialog";
import { TodoPanel } from "../workspace/TodoPanel";
import ChatInput, { type ChatInputHandle } from "./ChatInput";
import ChatMessageList from "./ChatMessageList";
import ChatQueueDrawer from "./ChatQueueDrawer";
import GitStatusBar from "./GitStatusBar";

interface ChatPanelProps {
	agentId: string;
	agentName?: string;
	sessionState: RendererSessionState;
	queue: { steering: string[]; followUp: string[] };
	phase: RendererSessionPhase;
	currentModel: string;
	currentThinking: string;
	onSend: (text: string, images?: ImageContent[], sendMode?: "steer" | "followUp") => Promise<boolean>;
	onThinkingChange: (level: ThinkingLevel) => void;
	onModelChange: (model: string) => void;
	onAbort?: () => void;
}

const ChatPanel = memo(function ChatPanel({
	agentId,
	agentName,
	sessionState,
	queue,
	phase,
	currentModel,
	currentThinking,
	onSend,
	onThinkingChange,
	onModelChange,
	onAbort,
}: ChatPanelProps) {
	const inputRef = useRef<ChatInputHandle>(null);
	const autoCollapse = useAtomValue(autoCollapseAtom);
	const activeAgent = useAtomValue(activeAgentAtom);
	const setShowSettings = useSetAtom(showSettingsAtom);
	const setSettingsTab = useSetAtom(settingsTabAtom);

	const availableThinkingLevels = useMemo(() => {
		const levels =
			activeAgent?.availableThinkingLevels && activeAgent.availableThinkingLevels.length > 0
				? activeAgent.availableThinkingLevels
				: (["off"] as ThinkingLevel[]);
		return levels;
	}, [activeAgent?.availableThinkingLevels]);

	const handleRequestApiKeys = useCallback(() => {
		setSettingsTab("api-keys");
		setShowSettings(true);
	}, [setSettingsTab, setShowSettings]);

	const isBusy = phase !== "idle";

	const handleAbort = useCallback(() => {
		onAbort?.();
	}, [onAbort]);

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
			{/* 轮次变更卡片已内嵌到消息流（ChatMessageList 按轮次插入） */}
			{/* TODO 进度条 — 替代原 SubAgent 进度卡片 */}
			<TodoPanel />
			<ChatQueueDrawer agentId={agentId} steerMessages={queue.steering} followUpMessages={queue.followUp} />
			<PlanQuestionDialog sessionId={agentId} />
			<ChatInput
				ref={inputRef}
				agentId={agentId}
				currentModel={currentModel}
				currentThinking={currentThinking}
				availableThinkingLevels={availableThinkingLevels}
				isBusy={isBusy}
				isCompacting={phase === "compacting"}
				onSend={onSend}
				onThinkingChange={onThinkingChange}
				onModelChange={onModelChange}
				onRequestApiKeys={handleRequestApiKeys}
				onAbort={handleAbort}
			/>
			{/* Git 状态栏在输入框下方，内容紧凑上移，不改变输入框位置 */}
			<GitStatusBar projectId={activeAgent?.projectId ?? ""} />
		</div>
	);
});

export default ChatPanel;
