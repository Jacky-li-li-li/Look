import type {
	PermissionAskQueueItem,
	PermissionMode,
	PlanApprovalRequest,
	PlanQuestionRequest,
	TodoItem,
} from "@shared/types";
import { atom } from "jotai";
import { atomFamily } from "jotai-family";

export const permissionModeAtomFamily = atomFamily((_agentId: string) => atom<PermissionMode>("ask"));

export const permissionAskQueueAtom = atom<PermissionAskQueueItem[]>([]);

export const planQuestionRequestAtomFamily = atomFamily((_agentId: string) => atom<PlanQuestionRequest | null>(null));

export interface PlanQuestionDraft {
	requestId: string | null;
	selections: Record<string, string[]>;
	otherEnabled: Record<string, boolean>;
	otherValues: Record<string, string>;
}

export const emptyPlanQuestionDraft = (): PlanQuestionDraft => ({
	requestId: null,
	selections: {},
	otherEnabled: {},
	otherValues: {},
});

export const planQuestionDraftAtomFamily = atomFamily((_agentId: string) =>
	atom<PlanQuestionDraft>(emptyPlanQuestionDraft()),
);

export const planApprovalRequestAtomFamily = atomFamily((_agentId: string) => atom<PlanApprovalRequest | null>(null));

export const todoItemsAtomFamily = atomFamily((_sessionId: string) => atom<TodoItem[]>([]));
