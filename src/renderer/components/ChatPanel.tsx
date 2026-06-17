// ============================================================
// ChatPanel — Whisper Bubbles + Line Input (Ink Wash, shadcn/ui)
//
// Thin orchestrator: composes ChatMessageList, ChatQueueDrawer,
// and ChatInput. All message merging, scroll/branch/copy logic
// lives in ChatMessageList; all input/skill/slash state lives
// in ChatInput.
// ============================================================

import type { AgentRole, AgentStatus, PermissionMode, PiMessage, ThinkingLevel } from "@shared/types";
import { memo, useCallback, useRef } from "react";
import ChatInput, { type ChatInputHandle } from "./ChatInput";
import ChatMessageList from "./ChatMessageList";
import ChatQueueDrawer from "./ChatQueueDrawer";

interface ChatPanelProps {
	agentId: string;
	agentRole?: AgentRole;
	agentName?: string;
	messages: PiMessage[];
	autoCollapse: boolean;
	queue: { steering: string[]; followUp: string[] };
	agentStatus: AgentStatus;
	currentModel: string;
	currentThinking: string;
	availableThinkingLevels?: ThinkingLevel[];
	currentPermissionMode: PermissionMode;
	onSend: (text: string) => void;
	onThinkingChange: (level: string) => void;
	onModelChange: (model: string) => void;
	onPermissionModeChange: (mode: PermissionMode) => void;
	onRequestApiKeys?: () => void;
	onAbort?: () => void;
}

export { ScrollToBottomButton } from "./ChatMessageList";

const ChatPanel = memo(function ChatPanel({
	agentId,
	agentRole,
	agentName,
	messages,
	autoCollapse,
	queue,
	agentStatus,
	currentModel,
	currentThinking,
	availableThinkingLevels,
	currentPermissionMode,
	onSend,
	onThinkingChange,
	onModelChange,
	onPermissionModeChange,
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
				agentRole={agentRole}
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
				currentPermissionMode={currentPermissionMode}
				isBusy={isBusy}
				onSend={onSend}
				onThinkingChange={onThinkingChange}
				onModelChange={onModelChange}
				onPermissionModeChange={onPermissionModeChange}
				onRequestApiKeys={onRequestApiKeys}
				onAbort={handleAbort}
			/>
		</div>
	);
});

export default ChatPanel;
