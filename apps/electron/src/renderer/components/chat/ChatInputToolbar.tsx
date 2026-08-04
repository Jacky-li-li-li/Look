// ============================================================
// ChatInputToolbar — 底部选择器行 + 发送/停止按钮
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import SimplePopover from "@look/ui/components/ui/simple-popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@look/ui/components/ui/tooltip";
import type { AgentDefinitionInfo, PermissionMode, ThinkingLevel } from "@shared/types";
import { Send, Square, Wrench } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import ContextRing from "./ContextRing";
import ModelSelector from "./ModelSelector";
import PermissionModeSelector from "./PermissionModeSelector";
import type { SkillEntry } from "./SkillSlashMenu";
import SubagentToggle from "./SubagentToggle";
import ThinkingSelector from "./ThinkingSelector";
import { type McpPickerEntry, ToolPickerPanel } from "./ToolPickerPanel";

export interface ToolPickerData {
	skills: SkillEntry[];
	agents: AgentDefinitionInfo[];
	mcpTools: McpPickerEntry[];
}

interface ChatInputToolbarProps {
	agentId: string;
	currentModel: string;
	currentThinking: string;
	availableThinkingLevels?: ThinkingLevel[];
	permissionMode: PermissionMode;
	isBusy: boolean;
	isCompacting: boolean;
	hasContent: boolean;
	onModelChange: (model: string) => void;
	onThinkingChange: (level: ThinkingLevel) => void;
	onRequestApiKeys?: () => void;
	onSend: () => void;
	onAbort?: () => void;
	/** Tool 面板数据源（技能 / Agent / MCP 工具）。 */
	toolData: ToolPickerData;
	/** Tool 面板选中后插入引用 token。 */
	onInsertToken: (token: string) => void;
}

const ChatInputToolbar = memo(function ChatInputToolbar({
	agentId,
	currentModel,
	currentThinking,
	availableThinkingLevels,
	permissionMode,
	isBusy,
	isCompacting,
	hasContent,
	onModelChange,
	onThinkingChange,
	onRequestApiKeys,
	onSend,
	onAbort,
	toolData,
	onInsertToken,
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
			<SimplePopover
				className="w-auto"
				preferredHeight={360}
				trigger={
					<Button
						variant="line-ghost"
						size="icon-sm"
						aria-label={t("chat.tools", "Tools")}
						title={t("chat.tools", "Tools")}
					>
						<Wrench data-icon="inline-start" className="size-3.5" />
					</Button>
				}
			>
				{({ close }) => (
					<ToolPickerPanel
						skills={toolData.skills}
						agents={toolData.agents}
						mcpTools={toolData.mcpTools}
						onInsert={(token) => {
							onInsertToken(token);
							close();
						}}
					/>
				)}
			</SimplePopover>
			<SubagentToggle />
			<div className="flex-1" />
			<ContextRing />
			{isBusy ? (
				<>
					{/* During compaction the CompactionStatusCard cancel button handles abortCompaction,
					    so the Square stop button (abortAgent) is hidden to avoid confusion. */}
					{!isCompacting && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="line-ghost"
									size="icon-sm"
									onClick={onAbort}
									aria-label={t("chat.stop")}
									className="text-muted-foreground hover:text-destructive"
								>
									<Square data-icon="inline-start" className="size-3 fill-current" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="bottom">{t("chat.stop")}</TooltipContent>
						</Tooltip>
					)}
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
