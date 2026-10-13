// ============================================================
// Shared types — thin re-export layer
//
// Domain types are organized in types/dto/ and types/events/.
// This file keeps core type aliases and re-exports everything
// to preserve backward compatibility with all existing imports.
// ============================================================

import type { MainToRendererEvent } from "./types/events/main-to-renderer.js";

// ============================================================
// Core type aliases (kept here to avoid circular imports)
// ============================================================

import type { ThinkingLevel } from "./types/dto/thinking.js";

export type { ThinkingLevel };

// Look-owned engine DTOs (no engine SDK re-exports; the pi adapter converts).
export type {
	LookAgentMessage,
	LookAssistantMessage,
	LookBashExecutionMessage,
	LookBranchSummaryEntry,
	LookBranchSummaryMessage,
	LookCompactionSummaryMessage,
	LookContextUsage,
	LookCustomMessage,
	LookImageContent,
	LookImageContent as ImageContent,
	LookModelInfo,
	LookSessionStats,
	LookSourceInfo,
	LookStopReason,
	LookTextContent,
	LookThinkingContent,
	LookToolCall,
	LookToolResultMessage,
	LookUsage,
	LookUserMessage,
} from "./types/dto/engine.js";

/** Event listener callback for event bus subscribers. */
export type EventCallback = (event: MainToRendererEvent) => void;

// ============================================================
// Re-exports from sub-modules
// ============================================================

// Contracts and domain (pass-through)
export type { PermissionMode } from "./contracts/permission.js";
export type {
	DesktopNotificationMode,
	LookTheme,
	LookThemeStyle,
	LookTone,
	MessageAlignment,
	ShowToolExecution,
	UILanguage,
	UserSettings,
} from "./contracts/settings.js";
export type { Draft, DraftPatch } from "./domain/drafts.js";
export type {
	ScheduledTask,
	ScheduledTaskInput,
	ScheduledTaskNotification,
	ScheduledTaskRetryPolicy,
	ScheduledTaskRunLog,
	ScheduledTaskRunStatus,
	ScheduledTaskSchedule,
	ScheduledTaskStatus,
	ScheduledTaskTestResult,
	TaskExecutionProfile,
	TaskRun,
	TaskRunSource,
} from "./domain/scheduler.js";
// Constants
export { DEFAULT_PROJECT_ID, LOOK_MESSAGE_DURATION_ENTRY_TYPE } from "./types/constants.js";
// Domain DTOs
export type { AgentDefinitionInfo, AgentDefinitionInput, AgentDefinitionSource, AgentInfo } from "./types/dto/agent.js";
export type { AttachmentRef, PendingAttachment } from "./types/dto/attachment.js";
export type {
	BrowserPanelAction,
	BrowserPanelState,
	BrowserPanelTabInfo,
	BrowserViewBounds,
	BrowserViewLayout,
} from "./types/dto/browser.js";
export type { GitDiffFile, GitRepoInfo } from "./types/dto/git.js";
export type {
	McpJsonSchemaPropertyDto,
	McpServerStatusEntry,
	McpToolDto,
	McpToolWithServer,
} from "./types/dto/mcp.js";
export type {
	AppUpdatePhase,
	FileTreeNode,
	ImSessionProvider,
	LookMessageDurationEntryData,
	TodoItem,
} from "./types/dto/misc.js";
export type {
	PermissionAskEvent,
	PermissionAskQueueItem,
	PermissionRespondPayload,
	PlanApprovalOutcome,
	PlanApprovalRequest,
	PlanApprovalResponse,
	PlanQuestion,
	PlanQuestionOption,
	PlanQuestionOutcome,
	PlanQuestionRequest,
	PlanQuestionResponse,
} from "./types/dto/permission.js";
export type { ProjectInfo } from "./types/dto/project.js";
export type { ProjectPromptDataDto, PromptEntry } from "./types/dto/prompt.js";
export type {
	AvailableModel,
	CustomProviderInput,
	CustomProviderModelInput,
	ModelTestResult,
	ProviderInfo,
	TestCustomProviderResult,
} from "./types/dto/provider.js";
export type { SecretStorageStatus } from "./types/dto/secrets.js";
export type {
	ForkedSessionResult,
	LookSessionEntry,
	NavigateTreeResult,
	SessionHistoryPage,
	SessionHistoryPreviewEnvelope,
	SessionHistoryWindow,
	SessionRuntimeSnapshot,
	SessionSnapshotEnvelope,
} from "./types/dto/session.js";
export type { SkillDiagnostic, SkillEntry } from "./types/dto/skill.js";
export type { SubagentCompletedEvent, SubagentProgressEvent } from "./types/dto/subagent.js";
export type {
	AggregatedUsage,
	ModelCostEntry,
	SdkUsage,
	SdkUsageCost,
	UsageData,
} from "./types/dto/usage.js";
export type { UserProfile } from "./types/dto/user.js";
// Events
export type { LoginPrompt, MainToRendererEvent } from "./types/events/main-to-renderer.js";
export type { RendererToMainEvent } from "./types/events/renderer-to-main.js";
// UI events (existing sub-module)
export type {
	LookUiEvent,
	LookUiPhase,
	LookUiStreamBlock,
	LookUiToolExecState,
	SessionUiEventEnvelope,
} from "./types/ui-events.js";
