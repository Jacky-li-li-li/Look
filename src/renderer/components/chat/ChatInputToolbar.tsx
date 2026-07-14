// ============================================================
// ChatInputToolbar — 底部选择器行 + 发送/停止按钮
// ============================================================

import { Button } from "@shared/components/ui/button";
import type { PermissionMode, ThinkingLevel } from "@shared/types";
import { Send, Square } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import ContextRing from "./ContextRing";
import ModelSelector from "./ModelSelector";
import PermissionModeSelector from "./PermissionModeSelector";
import SubagentToggle from "./SubagentToggle";
import ThinkingSelector from "./ThinkingSelector";

interface ChatInputToolbarProps {
	agentId: string;
	currentModel: string;
	currentThinking: string;
	availableThinkingLevels?: ThinkingLevel[];
	permissionMode: PermissionMode;
	isBusy: boolean;
	hasContent: boolean;
	onModelChange: (model: string) => void;
	onThinkingChange: (level: string) => void;
	onRequestApiKeys?: () => void;
	onSend: () => void;
	onAbort?: () => void;
}

const ChatInputToolbar = memo(function ChatInputToolbar({
	agentId,
	currentModel,
	currentThinking,
	availableThinkingLevels,
	permissionMode,
	isBusy,
	hasContent,
	onModelChange,
	onThinkingChange,
	onRequestApiKeys,
	onSend,
	onAbort,
}: ChatInputToolbarProps) {
	const { t } = useTranslation();

	return (
		<div className="flex items-center gap-1.5 px-2 py-2">
			<ModelSelector
				agentId={agentId}
				currentModel={currentModel}
				onModelChanged={onModelChange}
				onRequestApiKeys={onRequestApiKeys}
			/>
			<ThinkingSelector
				currentLevel={currentThinking}
				availableThinkingLevels={availableThinkingLevels}
				onChanged={onThinkingChange}
			/>
			<PermissionModeSelector agentId={agentId} currentMode={permissionMode} />
			<SubagentToggle />
			<div className="flex-1" />
			<ContextRing />
			{isBusy ? (
				<>
					<Button
						variant="line-ghost"
						size="icon-sm"
						onClick={onAbort}
						aria-label={t("chat.stop")}
						title={t("chat.stop")}
						className="text-muted-foreground hover:text-destructive"
					>
						<Square data-icon="inline-start" className="size-3 fill-current" />
					</Button>
					<Button
						variant={hasContent ? "line-filled" : "line-ghost"}
						size="icon-sm"
						onClick={() => void onSend()}
						disabled={!hasContent}
						aria-label={t("chat.send")}
					>
						<Send data-icon="inline-start" className="size-3.5" />
					</Button>
				</>
			) : (
				<Button
					variant={hasContent ? "line-filled" : "line-ghost"}
					size="icon-sm"
					onClick={() => void onSend()}
					disabled={!hasContent}
					aria-label={t("chat.send")}
				>
					<Send data-icon="inline-start" className="size-3.5" />
				</Button>
			)}
		</div>
	);
});

export default ChatInputToolbar;
