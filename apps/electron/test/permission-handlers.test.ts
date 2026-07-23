import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appStore } from "../src/renderer/store/appStore";
import {
	permissionAskQueueAtom,
	planApprovalRequestAtomFamily,
	planQuestionDraftAtomFamily,
	planQuestionRequestAtomFamily,
	todoItemsAtomFamily,
} from "../src/renderer/store/atoms";
import { handlePermissionEvent } from "../src/renderer/store/permissionHandlers";

const agentId = "agent-a";

describe("handlePermissionEvent", () => {
	beforeEach(() => {
		appStore.set(permissionAskQueueAtom, []);
	});

	afterEach(() => {
		appStore.set(permissionAskQueueAtom, []);
		appStore.set(planQuestionRequestAtomFamily(agentId), null);
		appStore.set(planQuestionDraftAtomFamily(agentId), {
			requestId: null,
			selections: {},
			otherEnabled: {},
			otherValues: {},
		});
		appStore.set(planApprovalRequestAtomFamily(agentId), null);
		appStore.set(todoItemsAtomFamily(agentId), []);
	});

	it("returns false for unhandled event types", () => {
		const result = handlePermissionEvent({ type: "session:snapshot" } as unknown as Parameters<
			typeof handlePermissionEvent
		>[0]);
		expect(result).toBe(false);
	});

	it("permission:ask appends to queue deduplicated by requestId", () => {
		const ask = { requestId: "r1", tool: "write", args: {}, title: "Write file" };
		handlePermissionEvent({
			type: "permission:ask",
			agentId,
			event: ask,
		} as unknown as Parameters<typeof handlePermissionEvent>[0]);
		handlePermissionEvent({
			type: "permission:ask",
			agentId,
			event: ask,
		} as unknown as Parameters<typeof handlePermissionEvent>[0]);

		expect(appStore.get(permissionAskQueueAtom)).toHaveLength(1);
		expect(appStore.get(permissionAskQueueAtom)[0]).toMatchObject({ ...ask, agentId });
	});

	it("permission:resolved removes matching request", () => {
		appStore.set(permissionAskQueueAtom, [
			{ requestId: "r1", agentId, tool: "write" },
			{ requestId: "r2", agentId, tool: "read" },
		]);
		handlePermissionEvent({
			type: "permission:resolved",
			requestId: "r1",
		} as unknown as Parameters<typeof handlePermissionEvent>[0]);
		expect(appStore.get(permissionAskQueueAtom)).toHaveLength(1);
		expect(appStore.get(permissionAskQueueAtom)[0].requestId).toBe("r2");
	});

	it("plan:question-requested sets request and resets draft", () => {
		const request = { requestId: "q1", questions: [] };
		handlePermissionEvent({
			type: "plan:question-requested",
			agentId,
			request,
		} as unknown as Parameters<typeof handlePermissionEvent>[0]);
		expect(appStore.get(planQuestionRequestAtomFamily(agentId))).toEqual(request);
		expect(appStore.get(planQuestionDraftAtomFamily(agentId)).requestId).toBe("q1");
	});

	it("plan:question-resolved clears request only for matching id", () => {
		appStore.set(planQuestionRequestAtomFamily(agentId), { requestId: "q1", questions: [] });
		handlePermissionEvent({
			type: "plan:question-resolved",
			agentId,
			requestId: "q2",
		} as unknown as Parameters<typeof handlePermissionEvent>[0]);
		expect(appStore.get(planQuestionRequestAtomFamily(agentId))).not.toBeNull();

		handlePermissionEvent({
			type: "plan:question-resolved",
			agentId,
			requestId: "q1",
		} as unknown as Parameters<typeof handlePermissionEvent>[0]);
		expect(appStore.get(planQuestionRequestAtomFamily(agentId))).toBeNull();
		expect(appStore.get(planQuestionDraftAtomFamily(agentId)).requestId).toBeNull();
	});

	it("plan:approval-requested sets request", () => {
		const request = { requestId: "a1", plan: [] };
		handlePermissionEvent({
			type: "plan:approval-requested",
			agentId,
			request,
		} as unknown as Parameters<typeof handlePermissionEvent>[0]);
		expect(appStore.get(planApprovalRequestAtomFamily(agentId))).toEqual(request);
	});

	it("plan:approval-resolved clears request only for matching id", () => {
		appStore.set(planApprovalRequestAtomFamily(agentId), { requestId: "a1", plan: [] });
		handlePermissionEvent({
			type: "plan:approval-resolved",
			agentId,
			requestId: "a2",
		} as unknown as Parameters<typeof handlePermissionEvent>[0]);
		expect(appStore.get(planApprovalRequestAtomFamily(agentId))).not.toBeNull();

		handlePermissionEvent({
			type: "plan:approval-resolved",
			agentId,
			requestId: "a1",
		} as unknown as Parameters<typeof handlePermissionEvent>[0]);
		expect(appStore.get(planApprovalRequestAtomFamily(agentId))).toBeNull();
	});

	it("todo:update sets items", () => {
		const items = [{ id: "t1", text: "task", completed: false }];
		handlePermissionEvent({
			type: "todo:update",
			sessionId: agentId,
			items,
		} as unknown as Parameters<typeof handlePermissionEvent>[0]);
		expect(appStore.get(todoItemsAtomFamily(agentId))).toEqual(items);
	});
});
