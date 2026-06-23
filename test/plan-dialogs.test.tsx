// @vitest-environment jsdom

import type { AgentInfo, PlanApprovalRequest, PlanQuestionRequest } from "@shared/types";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, useAtomValue } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PlanApprovalDialog from "../src/renderer/components/PlanApprovalDialog";
import PlanQuestionDialog from "../src/renderer/components/PlanQuestionDialog";
import {
	activeAgentIdAtom,
	agentsAtom,
	emptyPlanQuestionDraft,
	permissionModeAtomFamily,
	planApprovalRequestAtomFamily,
	planQuestionDraftAtomFamily,
	planQuestionRequestAtomFamily,
} from "../src/renderer/store/atoms";
import { appStore } from "../src/renderer/store/ipcHandler";

const usage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const agent: AgentInfo = {
	id: "session-a",
	name: "Session A",
	model: "test/model",
	thinkingLevel: "off",
	status: "working",
	messageCount: 1,
	createdAt: 1,
	usage,
};

const questionRequest: PlanQuestionRequest = {
	requestId: "question-1",
	sessionId: "session-a",
	questions: [
		{
			question: "Which scope?",
			header: "Scope",
			options: [
				{ label: "Small", description: "Minimal change" },
				{ label: "Large", description: "Broad change" },
			],
		},
	],
};

const approvalRequest: PlanApprovalRequest = {
	requestId: "approval-1",
	planId: "plan-1",
	sessionId: "session-a",
	plan: "# Implementation plan\n\n1. Change the runtime.",
	filePath: "/project/.context/plan/session-a.md",
};

function renderWithStore(component: React.ReactNode) {
	return render(<Provider store={appStore}>{component}</Provider>);
}

function ActivePlanQuestionDialog() {
	const sessionId = useAtomValue(activeAgentIdAtom);
	return (
		<>
			<output data-testid="active-session">{sessionId}</output>
			<PlanQuestionDialog key={sessionId ?? "none"} sessionId={sessionId} />
		</>
	);
}

describe("Plan dialogs", () => {
	const respondPlanQuestion = vi.fn();
	const respondPlanApproval = vi.fn();

	beforeEach(() => {
		respondPlanQuestion.mockReset().mockResolvedValue({ success: true });
		respondPlanApproval.mockReset().mockResolvedValue({ success: true });
		Object.defineProperty(window, "look", {
			configurable: true,
			value: { respondPlanQuestion, respondPlanApproval },
		});
		appStore.set(activeAgentIdAtom, "session-a");
		appStore.set(agentsAtom, [agent]);
		appStore.set(planQuestionRequestAtomFamily("session-a"), null);
		appStore.set(planQuestionDraftAtomFamily("session-a"), emptyPlanQuestionDraft());
		appStore.set(planApprovalRequestAtomFamily("session-a"), null);
		appStore.set(planQuestionRequestAtomFamily("session-b"), null);
		appStore.set(planQuestionDraftAtomFamily("session-b"), emptyPlanQuestionDraft());
		appStore.set(planApprovalRequestAtomFamily("session-b"), null);
	});

	afterEach(() => {
		cleanup();
		document.body.replaceChildren();
		appStore.set(activeAgentIdAtom, null);
	});

	it("requires every question to be answered and submits a session-scoped response", async () => {
		appStore.set(planQuestionRequestAtomFamily("session-a"), questionRequest);
		renderWithStore(<ActivePlanQuestionDialog />);
		const submit = screen.getByRole("button", { name: "提交答案" });
		expect((submit as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: /Small/ }));
		expect((submit as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(submit);
		await waitFor(() =>
			expect(respondPlanQuestion).toHaveBeenCalledWith({
				requestId: "question-1",
				sessionId: "session-a",
				answers: { "Which scope?": "Small" },
			}),
		);
	});

	it("keeps background-session questions hidden", () => {
		appStore.set(planQuestionRequestAtomFamily("session-b"), { ...questionRequest, sessionId: "session-b" });
		renderWithStore(<ActivePlanQuestionDialog />);
		expect(screen.queryByText("规划问题")).toBeNull();
	});

	it("preserves partial answers while switching sessions", async () => {
		appStore.set(planQuestionRequestAtomFamily("session-a"), questionRequest);
		renderWithStore(<ActivePlanQuestionDialog />);
		fireEvent.click(screen.getByRole("button", { name: /Small/ }));
		expect((screen.getByRole("button", { name: "提交答案" }) as HTMLButtonElement).disabled).toBe(false);
		act(() => appStore.set(activeAgentIdAtom, "session-b"));
		expect(screen.getByTestId("active-session").textContent).toBe("session-b");
		await waitFor(() => expect(screen.queryByText("规划问题")).toBeNull());
		act(() => appStore.set(activeAgentIdAtom, "session-a"));
		await waitFor(() =>
			expect((screen.getByRole("button", { name: "提交答案" }) as HTMLButtonElement).disabled).toBe(false),
		);
	});

	it("combines multi-select labels with a custom Other answer", async () => {
		appStore.set(planQuestionRequestAtomFamily("session-a"), {
			...questionRequest,
			questions: [{ ...questionRequest.questions[0], multiSelect: true }],
		});
		renderWithStore(<ActivePlanQuestionDialog />);
		fireEvent.click(screen.getByRole("button", { name: /Small/ }));
		fireEvent.click(screen.getByRole("button", { name: "Other" }));
		fireEvent.change(screen.getByPlaceholderText("输入自定义答案"), { target: { value: "Custom" } });
		fireEvent.click(screen.getByRole("button", { name: "提交答案" }));
		await waitFor(() =>
			expect(respondPlanQuestion).toHaveBeenCalledWith(
				expect.objectContaining({ answers: { "Which scope?": "Small, Custom" } }),
			),
		);
	});

	it("approves the displayed plan and updates the session permission atom", async () => {
		appStore.set(planApprovalRequestAtomFamily("session-a"), approvalRequest);
		appStore.set(permissionModeAtomFamily("session-a"), "plan");
		renderWithStore(<PlanApprovalDialog sessionId="session-a" />);
		expect(screen.getByText("Implementation plan")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "批准并执行" }));
		await waitFor(() => expect(respondPlanApproval).toHaveBeenCalledWith({ requestId: "approval-1", sessionId: "session-a", action: "approve" }));
		expect(appStore.get(permissionModeAtomFamily("session-a"))).toBe("always");
	});
});
