import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "../../contracts/permission.js";
import type { SessionUiEventEnvelope } from "../../types/ui-events.js";
import type { AgentInfo } from "../dto/agent.js";
import type { GitRepoInfo } from "../dto/git.js";
import type { AppUpdatePhase, TodoItem } from "../dto/misc.js";
import type { PermissionAskEvent, PlanApprovalRequest, PlanQuestionRequest } from "../dto/permission.js";
import type { ProjectInfo } from "../dto/project.js";
import type { SessionSnapshotEnvelope } from "../dto/session.js";
import type { SubagentCompletedEvent, SubagentProgressEvent } from "../dto/subagent.js";

type WithAgentId<T> = T & { agentId: string };

/** Events sent from main process to renderer */
export type MainToRendererEvent =
	| SessionUiEventEnvelope
	| SessionSnapshotEnvelope
	// ---- Look-specific events (no pi equivalent) ----
	| { type: "agent:list"; projectId: string; agents: AgentInfo[] }
	| WithAgentId<{ type: "agent:created"; agent: AgentInfo }>
	| WithAgentId<{ type: "agent:destroyed" }>
	| WithAgentId<{ type: "agent:updated"; agent: AgentInfo }>
	| { type: "error"; agentId?: string; message: string }
	// ---- Permission events ----
	| { type: "permission:ask"; agentId: string; event: PermissionAskEvent }
	| { type: "permission:resolved"; agentId: string; requestId: string }
	| { type: "permission:mode-changed"; agentId: string; mode: PermissionMode }
	// ---- Plan interaction events ----
	| { type: "plan:question-requested"; agentId: string; request: PlanQuestionRequest }
	| { type: "plan:question-resolved"; agentId: string; requestId: string }
	| { type: "plan:approval-requested"; agentId: string; request: PlanApprovalRequest }
	| { type: "plan:approval-resolved"; agentId: string; requestId: string }
	// ---- File viewer window ----
	| { type: "fileViewer:open-path"; path: string }
	// 独立查看器窗口请求合并后，主进程通知主窗口打开右侧 Dock 面板。
	| { type: "fileViewer:docked"; path: string }
	// ---- SubAgent events ----
	| { type: "subagent:definitions-updated" }
	| ({ type: "session:subagent-progress" } & SubagentProgressEvent)
	| ({ type: "session:subagent-completed" } & SubagentCompletedEvent)
	| { type: "project:list"; projects: ProjectInfo[]; activeProjectId: string | null }
	| { type: "project:active-changed"; projectId: string }
	| { type: "project:git-info"; projectId: string; info: GitRepoInfo | null }
	| {
			type: "project:confirm-delete";
			projectId: string;
			projectName: string;
			agentCount: number;
			runningCount: number;
	  }
	// ---- Shared area events ----
	| { type: "shared:updated"; projectId: string }
	// ---- Workspace tree events ----
	| { type: "workspace:updated"; projectId: string; relativePath: string }
	// ---- IM / Feishu channel events ----
	| {
			type: "im:registration-update";
			registrationId: string;
			phase: "qr" | "polling" | "success" | "error";
			url?: string;
			expireIn?: number;
			error?: string;
			appId?: string;
	  }
	| {
			type: "im:channel-status";
			provider: string;
			status: "connected" | "disconnected" | "connecting" | "error";
			appId?: string;
			error?: string;
	  }
	| {
			type: "im:message-received";
			provider: string;
			messageId: string;
			chatId: string;
			senderId: string;
			senderName?: string;
			content: string;
			rawContentType: string;
			createTime: number;
			raw?: unknown;
	  }
	// ---- IM Bridge status events ----
	| { type: "im:bridge-status"; bindings: number; runningSessions: string[]; status: "running" | "stopped" }
	// ---- TODO.md task progress ----
	| { type: "todo:update"; sessionId: string; items: TodoItem[] }
	// ---- MCP server status changed ----
	| { type: "mcp:status-changed" }
	// ---- Model list refreshed (API key changed / OAuth login / startup) ----
	| { type: "model:updated" }
	// ---- Usage data updated ----
	| WithAgentId<{ type: "agent:context-usage"; contextUsage: ContextUsage }>
	| { type: "usage:updated" }
	// ---- OAuth login prompt (main → renderer) ----
	| { type: "login:prompt"; providerId: string; promptId: string; prompt: LoginPrompt }
	| { type: "login:completed"; providerId: string; success: boolean; error?: string }
	// ---- App auto-update (main → renderer) ----
	| { type: "update:status"; phase: AppUpdatePhase; version?: string; percent?: number; error?: string }
	// ---- Window state (main → renderer) ----
	| { type: "window:fullscreen-changed"; fullscreen: boolean }
	// ---- App lifecycle (main → renderer) ----
	// 主进程 IPC handlers 注册完成后的就绪信号；渲染进程收到后才发起首次 IPC 调用，
	// 避免启动竞态（No handler registered for 'look:invoke'）。
	| { type: "app:ready" }
	// ---- Desktop notification click (main → renderer) ----
	// 用户点击系统桌面通知后，主进程请求渲染进程激活对应会话。
	| { type: "notification:activate-session"; agentId: string }
	| { type: "session:activated"; agentId: string };

/** OAuth login prompt variants sent from main to renderer. */
export type LoginPrompt =
	| { type: "select"; message: string; options: Array<{ id: string; label: string; description?: string }> }
	| { type: "manual_code"; message: string; placeholder?: string }
	| { type: "info"; message: string }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string }
	| { type: "progress"; message: string };
