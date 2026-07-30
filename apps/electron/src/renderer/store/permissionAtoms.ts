import type {
	PermissionAskQueueItem,
	PermissionMode,
	PlanApprovalRequest,
	PlanQuestionRequest,
	TodoItem,
} from "@shared/types";
import { atom } from "jotai";
import { atomFamily } from "jotai-family";
import { registerAgentFamily } from "./atomFamilyRegistry";

export const permissionModeAtomFamily = atomFamily((_agentId: string) => atom<PermissionMode>("ask"));
registerAgentFamily(permissionModeAtomFamily);

export const permissionAskQueueAtom = atom<PermissionAskQueueItem[]>([]);

export const planQuestionRequestAtomFamily = atomFamily((_agentId: string) => atom<PlanQuestionRequest | null>(null));
registerAgentFamily(planQuestionRequestAtomFamily);

export interface PlanQuestionDraft {
	requestId: string | null;
	activeTab: number;
	focusedOptionIndex: number;
	selections: Record<string, string[]>;
	otherEnabled: Record<string, boolean>;
	otherValues: Record<string, string>;
}

export const emptyPlanQuestionDraft = (): PlanQuestionDraft => ({
	requestId: null,
	activeTab: 0,
	focusedOptionIndex: -1,
	selections: {},
	otherEnabled: {},
	otherValues: {},
});

export const planQuestionDraftAtomFamily = atomFamily((_agentId: string) =>
	atom<PlanQuestionDraft>(emptyPlanQuestionDraft()),
);
registerAgentFamily(planQuestionDraftAtomFamily);

export const planApprovalRequestAtomFamily = atomFamily((_agentId: string) => atom<PlanApprovalRequest | null>(null));
registerAgentFamily(planApprovalRequestAtomFamily);

export const todoItemsAtomFamily = atomFamily((_sessionId: string) => atom<TodoItem[]>([]));
registerAgentFamily(todoItemsAtomFamily);
