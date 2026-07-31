import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

/** pi SDK tool_call handler — returned by IPermissionService.createToolCallHandler. */
export type ToolCallHandler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult>;

/** Permission ask event — sent from main to renderer when a tool needs approval */
export interface PermissionAskEvent {
	toolName: string;
	toolInput: Record<string, unknown>;
	toolDescription: string;
	requestId: string;
	expiresAt: number;
}

export interface PermissionAskQueueItem extends PermissionAskEvent {
	agentId: string;
}

/** Permission response — sent from renderer to main with user decision */
export interface PermissionRespondPayload {
	requestId: string;
	action: "allow" | "deny" | "allow_always";
}

// ── Plan-mode interaction types ──

/** Outcome of a plan-mode question dialogue. */
export interface PlanQuestionOutcome {
	status: "answered" | "cancelled";
	answers?: Record<string, string>;
	reason?: string;
}

/** Outcome of a plan-mode approval step. */
export interface PlanApprovalOutcome {
	status: "approved" | "rejected" | "cancelled";
	planId?: string;
	filePath?: string;
	reason?: string;
}

export interface PlanQuestionOption {
	label: string;
	description: string;
	/** Optional long-form markdown preview shown for the currently focused option. */
	preview?: string;
}

export interface PlanQuestion {
	question: string;
	header: string;
	options: PlanQuestionOption[];
	multiSelect?: boolean;
}

export interface PlanQuestionRequest {
	requestId: string;
	sessionId: string;
	questions: PlanQuestion[];
}

export interface PlanQuestionResponse {
	requestId: string;
	sessionId: string;
	answers: Record<string, string>;
	/** Set to true when the user dismisses the dialog without answering (Escape, backdrop click, timeout). */
	cancelled?: boolean;
}

export interface PlanApprovalRequest {
	requestId: string;
	planId: string;
	sessionId: string;
	plan: string;
	filePath: string;
	/** Extracted from the first # Heading in the plan markdown, or undefined. */
	title?: string;
}

export interface PlanApprovalResponse {
	requestId: string;
	sessionId: string;
	action: "approve" | "reject";
}
