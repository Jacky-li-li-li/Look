// ============================================================
// ChatPanel — Whisper Bubbles + Line Input (Ink Wash, shadcn/ui)
//
// Thin orchestrator: composes ChatMessageList, ChatQueueDrawer,
// and ChatInput. All message merging, scroll/branch/copy logic
// lives in ChatMessageList; all input/skill/slash state lives
// in ChatInput.
// ============================================================

import type { PiMessage, SessionStatus, ThinkingLevel } from "@shared/types";
import { memo, useCallback, useRef } from "react";
import ChatInput, { type ChatInputHandle } from "./ChatInput";
import ChatMessageList from "./ChatMessageList";
import ChatQueueDrawer from "./ChatQueueDrawer";

interface ChatPanelProps {
	agentId: string;
	agentName?: string;
	messages: PiMessage[];
	autoCollapse: boolean;
	queue: { steering: string[]; followUp: string[] };
	agentStatus: SessionStatus;
	currentModel: string;
	currentThinking: string;
	availableThinkingLevels?: ThinkingLevel[];
	onSend: (text: string) => void;
	onThinkingChange: (level: string) => void;
	onModelChange: (model: string) => void;
	onRequestApiKeys?: () => void;
	onAbort?: () => void;
}

export { ScrollToBottomButton } from "./ChatMessageList";

const ChatPanel = memo(function ChatPanel({
	agentId,
	agentName,
	messages,
	autoCollapse,
	queue,
	agentStatus,
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

	const isBusy = agentStatus === "thinking" || agentStatus === "working";

	const handleAbort = useCallback(() => {
		onAbort?.();
	}, [onAbort]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<ChatMessageList
				agentId={agentId}
				agentName={agentName}
				messages={messages}
				autoCollapse={autoCollapse}
				agentStatus={agentStatus}
				isBusy={isBusy}
				inputRef={inputRef}
				onSend={onSend}
			/>
			<ChatQueueDrawer queue={queue} />
			<ChatInput
				ref={inputRef}
				agentId={agentId}
				agentStatus={agentStatus}
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
