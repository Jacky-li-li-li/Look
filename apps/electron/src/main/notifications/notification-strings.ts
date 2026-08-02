// ============================================================
// NotificationStrings — lightweight OS notification copy table
//
// The main process has no react-i18next (that lives in the renderer),
// so desktop notification copy is resolved here from the persisted
// UI language (UserSettings.language). Keeps notifications consistent
// with the in-app UI language without pulling an i18n framework into
// the main process.
// ============================================================

import type { UILanguage } from "@look/shared/types";

export interface NotificationStrings {
	/** Session name fallback when no AgentInfo is available. */
	fallbackSessionName: string;
	/** Title suffix for needs-action notifications: `<session> · <suffix>`. */
	needsActionTitleSuffix: string;
	/** Title suffix for task-completed notifications. */
	completedTitleSuffix: string;
	/** Title suffix for error notifications. */
	errorTitleSuffix: string;
	/** Title / body for OAuth login prompts (no session context). */
	loginTitle: string;
	loginBody: string;
	/** Body for permission:ask — `session: Agent 请求执行工具 <tool>`. */
	permissionBody(sessionName: string, toolName: string): string;
	/** Body for plan:question-requested. */
	planQuestionBody(sessionName: string): string;
	/** Body for plan:approval-requested. */
	planApprovalBody(sessionName: string): string;
	/** Body for agent_end task completion. */
	completedBody(sessionName: string): string;
	/** Body for session-scoped errors. */
	errorBodyWithSession(sessionName: string, message: string): string;
	/** Body for global errors (no agentId). */
	errorBodyGlobal(message: string): string;
}

const EN: NotificationStrings = {
	fallbackSessionName: "Session",
	needsActionTitleSuffix: "Needs action",
	completedTitleSuffix: "Task finished",
	errorTitleSuffix: "Error",
	loginTitle: "Login required",
	loginBody: "A provider needs you to finish signing in",
	permissionBody: (name, tool) => `${name}: Agent requests permission to use ${tool}`,
	planQuestionBody: (name) => `${name}: Agent has questions for you`,
	planApprovalBody: (name) => `${name}: Plan is waiting for your approval`,
	completedBody: (name) => `${name}: Agent finished this turn`,
	errorBodyWithSession: (name, message) => `${name}: ${message}`,
	errorBodyGlobal: (message) => message,
};

const ZH: NotificationStrings = {
	fallbackSessionName: "会话",
	needsActionTitleSuffix: "需要操作",
	completedTitleSuffix: "任务完成",
	errorTitleSuffix: "出错",
	loginTitle: "登录提示",
	loginBody: "提供商需要你完成登录",
	permissionBody: (name, tool) => `${name}：Agent 请求执行工具 ${tool}`,
	planQuestionBody: (name) => `${name}：Agent 有问题等你回答`,
	planApprovalBody: (name) => `${name}：等待你批准计划`,
	completedBody: (name) => `${name}：Agent 已完成本轮任务`,
	errorBodyWithSession: (name, message) => `${name}：${message}`,
	errorBodyGlobal: (message) => message,
};

const JA: NotificationStrings = {
	fallbackSessionName: "セッション",
	needsActionTitleSuffix: "操作が必要",
	completedTitleSuffix: "タスク完了",
	errorTitleSuffix: "エラー",
	loginTitle: "ログインが必要",
	loginBody: "プロバイダーのログインを完了してください",
	permissionBody: (name, tool) => `${name}: エージェントがツール ${tool} の実行を要求しています`,
	planQuestionBody: (name) => `${name}: エージェントから質問があります`,
	planApprovalBody: (name) => `${name}: プランの承認を待っています`,
	completedBody: (name) => `${name}: エージェントがこのターンを完了しました`,
	errorBodyWithSession: (name, message) => `${name}: ${message}`,
	errorBodyGlobal: (message) => message,
};

const TABLES: Record<UILanguage, NotificationStrings> = {
	en: EN,
	zh: ZH,
	ja: JA,
};

/** Resolve the copy table for a UI language; unknown values fall back to English. */
export function notificationStrings(language: UILanguage | string | undefined): NotificationStrings {
	return TABLES[language as UILanguage] ?? EN;
}
