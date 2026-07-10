// ============================================================
// ChatPanel — Whisper Bubbles + Line Input (Ink Wash, shadcn/ui)
//
// Thin orchestrator: composes ChatMessageList, ChatQueueDrawer,
// and ChatInput. All message merging, scroll/branch/copy logic
// lives in ChatMessageList; all input/skill/slash state lives
// in ChatInput.
// ============================================================

import type { ImageContent, ThinkingLevel } from "@shared/types";
import { memo, useCallback, useRef } from "react";
import type { RendererSessionPhase, RendererSessionState } from "../store/sessionTypes";
import ChatInput, { type ChatInputHandle } from "./ChatInput";
import ChatMessageList from "./ChatMessageList";
import ChatQueueDrawer from "./ChatQueueDrawer";
import { TodoPanel } from "./TodoPanel";

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
	onDequeueAll?: () => void;
}

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
	onDequeueAll,
}: ChatPanelProps) {
	const inputRef = useRef<ChatInputHandle>(null);

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
			{/* TODO 进度条 — 替代原 SubAgent 进度卡片 */}
			<TodoPanel />
			<ChatQueueDrawer
				steerMessages={queue.steering}
				followUpMessages={queue.followUp}
				onDequeueAll={() => onDequeueAll?.()}
			/>
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
