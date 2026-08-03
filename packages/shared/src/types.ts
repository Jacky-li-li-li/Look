// ============================================================
// Shared types — thin re-export layer
//
// Domain types are organized in types/dto/ and types/events/.
// This file keeps core type aliases and re-exports everything
// to preserve backward compatibility with all existing imports.
// ============================================================

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MainToRendererEvent } from "./types/events/main-to-renderer.js";

// ============================================================
// Core type aliases (kept here to avoid circular imports)
// ============================================================

export type ThinkingLevel = ModelThinkingLevel;
export type { AgentMessage, ImageContent, SessionEntry };

/** Event listener callback for event bus subscribers. */
export type EventCallback = (event: MainToRendererEvent) => void;

// ============================================================
// Re-exports from sub-modules
// ============================================================

// Contracts and domain (pass-through)
export type { PermissionMode } from "./contracts/permission.js";
export type { DesktopNotificationMode, LookTone, UILanguage, UserSettings } from "./contracts/settings.js";
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
export type { GitRepoInfo } from "./types/dto/git.js";
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
	ToolCallHandler,
} from "./types/dto/permission.js";
export type { ProjectInfo } from "./types/dto/project.js";
export type {
	AvailableModel,
	CustomProviderInput,
	CustomProviderModelInput,
	ModelTestResult,
	ProviderInfo,
	TestCustomProviderResult,
} from "./types/dto/provider.js";
export type {
	ForkedSessionResult,
	LookSessionEntry,
	NavigateTreeResult,
	SessionRuntimeSnapshot,
	SessionSnapshotEnvelope,
} from "./types/dto/session.js";
export type { SubagentCompletedEvent, SubagentProgressEvent } from "./types/dto/subagent.js";
export type { UserProfile } from "./types/dto/user.js";
// Events
export type { LoginPrompt, MainToRendererEvent } from "./types/events/main-to-renderer.js";
export type { RendererToMainEvent } from "./types/events/renderer-to-main.js";
// Look Island (wire contract with the native Swift helper)
export type {
	LookIslandActivityLine,
	LookIslandDisplayMode,
	LookIslandDisplayPolicy,
	LookIslandDisplayState,
	LookIslandDownlinkMessage,
	LookIslandInteraction,
	LookIslandInteractionKind,
	LookIslandNativeFrame,
	LookIslandNativeScreenMetrics,
	LookIslandNotchStatus,
	LookIslandPhase,
	LookIslandPillSnapshot,
	LookIslandRect,
	LookIslandSessionSnapshot,
	LookIslandSettings,
	LookIslandStrings,
	LookIslandSubagentSnapshot,
	LookIslandSubagentStatus,
	LookIslandUplinkMessage,
} from "./types/look-island.js";
export {
	computeLookIslandSimulatedNotchWidth,
	DEFAULT_LOOK_ISLAND_SETTINGS,
	DEFAULT_LOOK_ISLAND_STRINGS,
	isLookIslandSupportedPlatform,
	LOOK_ISLAND_CARRIER_COMPACT_INSET,
	LOOK_ISLAND_CLOSED_HEIGHT,
	LOOK_ISLAND_COMPACT_ACTIVE_WIDTH,
	LOOK_ISLAND_COMPACT_HARDWARE_EXTRA_WIDTH,
	LOOK_ISLAND_COMPACT_IDLE_WIDTH,
	LOOK_ISLAND_COMPACT_MIN_WIDTH,
	LOOK_ISLAND_MAX_EXPANDED_HEIGHT,
	LOOK_ISLAND_MAX_EXPANDED_WIDTH,
	LOOK_ISLAND_MIN_DARWIN_MAJOR,
	LOOK_ISLAND_MIN_EXPANDED_WIDTH,
	LOOK_ISLAND_PROTOCOL_VERSION,
	LOOK_ISLAND_SCREEN_EDGE_GUTTER,
	LOOK_ISLAND_SIMULATED_NOTCH_MAX_WIDTH,
	LOOK_ISLAND_SIMULATED_NOTCH_MIN_WIDTH,
	LOOK_ISLAND_SIMULATED_NOTCH_WIDTH_RATIO,
	normalizeLookIslandSettings,
} from "./types/look-island.js";
// UI events (existing sub-module)
export type {
	LookUiEvent,
	LookUiPhase,
	LookUiStreamBlock,
	LookUiToolExecState,
	SessionUiEventEnvelope,
} from "./types/ui-events.js";
