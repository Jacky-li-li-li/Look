import type { MainToRendererEvent } from "@shared/types";
import { appStore } from "./appStore";
import {
	emptyPlanQuestionDraft,
	permissionAskQueueAtom,
	permissionModeAtomFamily,
	planApprovalRequestAtomFamily,
	planQuestionDraftAtomFamily,
	planQuestionRequestAtomFamily,
	todoItemsAtomFamily,
} from "./atoms";

export function handlePermissionEvent(event: MainToRendererEvent): boolean {
	switch (event.type) {
		case "permission:ask": {
			const item = { ...event.event, agentId: event.agentId };
			const queue = appStore.get(permissionAskQueueAtom);
			if (queue.some((pending) => pending.requestId === item.requestId)) return true;

			// Auto-deny pending permission requests from a different session.
			// Without this, switching sessions while a permission dialog is open
			// would block the new session's dialog with the old session's request.
			const otherSessionItems = queue.filter((pending) => pending.agentId !== item.agentId);
			if (otherSessionItems.length > 0) {
				for (const pending of otherSessionItems) {
					void window.look.respondPermission({ requestId: pending.requestId, action: "deny" }).catch(() => {});
				}
				const currentSessionItems = queue.filter((pending) => pending.agentId === item.agentId);
				appStore.set(permissionAskQueueAtom, [...currentSessionItems, item]);
			} else {
				appStore.set(permissionAskQueueAtom, [...queue, item]);
			}
			return true;
		}

		case "permission:resolved":
			appStore.set(
				permissionAskQueueAtom,
				appStore.get(permissionAskQueueAtom).filter((item) => item.requestId !== event.requestId),
			);
			return true;

		case "plan:question-requested": {
			appStore.set(planQuestionRequestAtomFamily(event.agentId), event.request);
			const draft = appStore.get(planQuestionDraftAtomFamily(event.agentId));
			if (draft.requestId !== event.request.requestId) {
				appStore.set(planQuestionDraftAtomFamily(event.agentId), {
					...emptyPlanQuestionDraft(),
					requestId: event.request.requestId,
				});
			}
			return true;
		}

		case "plan:question-resolved": {
			const current = appStore.get(planQuestionRequestAtomFamily(event.agentId));
			if (current?.requestId === event.requestId) {
				appStore.set(planQuestionRequestAtomFamily(event.agentId), null);
				appStore.set(planQuestionDraftAtomFamily(event.agentId), emptyPlanQuestionDraft());
			}
			return true;
		}

		case "plan:approval-requested":
			appStore.set(planApprovalRequestAtomFamily(event.agentId), event.request);
			return true;

		case "plan:approval-resolved": {
			const current = appStore.get(planApprovalRequestAtomFamily(event.agentId));
			if (current?.requestId === event.requestId) {
				appStore.set(planApprovalRequestAtomFamily(event.agentId), null);
			}
			return true;
		}

		case "permission:mode-changed":
			appStore.set(permissionModeAtomFamily(event.agentId), event.mode);
			return true;

		case "todo:update":
			appStore.set(todoItemsAtomFamily(event.sessionId), event.items);
			return true;

		default:
			return false;
	}
}
