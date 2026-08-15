// @vitest-environment jsdom

import { TooltipProvider } from "@look/ui/components/ui/tooltip";
import type { AgentInfo, PlanApprovalRequest, PlanQuestionRequest } from "@shared/types";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, useAtomValue } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PlanApprovalDialog from "../src/renderer/components/dialogs/PlanApprovalDialog";
import PlanQuestionDialog from "../src/renderer/components/dialogs/PlanQuestionDialog";
import { appStore } from "../src/renderer/store/appStore";
import {
	activeAgentIdAtom,
	agentsAtom,
	emptyPlanQuestionDraft,
	permissionModeAtomFamily,
	planApprovalRequestAtomFamily,
	planQuestionDraftAtomFamily,
	planQuestionRequestAtomFamily,
} from "../src/renderer/store/atoms";

// jsdom 缺少 scrollIntoView / ResizeObserver（Radix tooltip 聚焦打开、Streamdown 预览依赖）
class ResizeObserverMock {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);
Object.defineProperty(Element.prototype, "scrollIntoView", { value: vi.fn(), writable: true });

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
	return render(
		<Provider store={appStore}>
			<TooltipProvider>{component}</TooltipProvider>
		</Provider>,
	);
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
		const submit = screen.getByRole("button", { name: "Confirm" });
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

	it("renders as a bottom-anchored overlay covering the chat input", () => {
		appStore.set(planQuestionRequestAtomFamily("session-a"), questionRequest);
		renderWithStore(<ActivePlanQuestionDialog />);
		const banner = document.querySelector(".ask-user-banner");
		expect(banner).not.toBeNull();
		// 底部覆盖层：绝对定位锚在输入框位置（GitStatusBar 20px 槽位之上），不占文档流
		expect(banner?.className).toContain("absolute");
		expect(banner?.className).toContain("bottom-5");
	});

	it("selects options with number keys", async () => {
		appStore.set(planQuestionRequestAtomFamily("session-a"), questionRequest);
		renderWithStore(<ActivePlanQuestionDialog />);
		expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.keyDown(document, { key: "1" });
		expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(false);
		// 单选：数字键 2 直接替换为 Large
		fireEvent.keyDown(document, { key: "2" });
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
		await waitFor(() =>
			expect(respondPlanQuestion).toHaveBeenCalledWith(
				expect.objectContaining({ answers: { "Which scope?": "Large" } }),
			),
		);
	});

	it("lets digits type into the custom answer input without selecting options", async () => {
		appStore.set(planQuestionRequestAtomFamily("session-a"), questionRequest);
		renderWithStore(<ActivePlanQuestionDialog />);
		fireEvent.keyDown(document, { key: "3" }); // 其他
		const input = screen.getByPlaceholderText("Type a custom answer...");
		// 自定义输入框聚焦时数字键照常键入，不应选中 Small
		fireEvent.keyDown(input, { key: "1" });
		fireEvent.change(input, { target: { value: "1st choice" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() =>
			expect(respondPlanQuestion).toHaveBeenCalledWith(
				expect.objectContaining({ answers: { "Which scope?": "1st choice" } }),
			),
		);
	});

	it("focuses the dialog on appear and traps Tab inside it", () => {
		appStore.set(planQuestionRequestAtomFamily("session-a"), questionRequest);
		renderWithStore(<ActivePlanQuestionDialog />);
		const dialog = screen.getByRole("dialog");
		expect(document.activeElement).toBe(dialog);
		// 可聚焦元素顺序：关闭按钮 → 选项 1/2/其他 →（Confirm 未答完时禁用，不参与循环）
		fireEvent.keyDown(document, { key: "Tab" });
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close and cancel this question" }));
		fireEvent.keyDown(document, { key: "Tab" });
		expect(document.activeElement).toBe(screen.getByRole("button", { name: /Small/ }));
		fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close and cancel this question" }));
	});

	it("returns focus to the chat input after submit and after cancel", async () => {
		const onHandled = vi.fn();
		appStore.set(planQuestionRequestAtomFamily("session-a"), questionRequest);
		renderWithStore(<PlanQuestionDialog sessionId="session-a" onHandled={onHandled} />);
		fireEvent.click(screen.getByRole("button", { name: /Small/ }));
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
		await waitFor(() => expect(onHandled).toHaveBeenCalledTimes(1));
		// Escape 取消同样归还焦点
		act(() =>
			appStore.set(planQuestionRequestAtomFamily("session-a"), { ...questionRequest, requestId: "question-2" }),
		);
		await waitFor(() => screen.getByRole("dialog"));
		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() => expect(onHandled).toHaveBeenCalledTimes(2));
	});

	it("returns focus when the question is resolved externally", async () => {
		const onHandled = vi.fn();
		appStore.set(planQuestionRequestAtomFamily("session-a"), questionRequest);
		renderWithStore(<PlanQuestionDialog sessionId="session-a" onHandled={onHandled} />);
		await waitFor(() => screen.getByRole("dialog"));
		// 外部解决（plan:question-resolved 事件直接清 atom，例如会话被中止）
		act(() => appStore.set(planQuestionRequestAtomFamily("session-a"), null));
		await waitFor(() => expect(onHandled).toHaveBeenCalledTimes(1));
	});

	it("shows an option preview on hover and clears it on leave", async () => {
		appStore.set(planQuestionRequestAtomFamily("session-a"), {
			...questionRequest,
			questions: [
				{
					...questionRequest.questions[0],
					options: [
						{ label: "Small", description: "Minimal change", preview: "small preview text" },
						{ label: "Large", description: "Broad change", preview: "large preview text" },
					],
				},
			],
		});
		renderWithStore(<ActivePlanQuestionDialog />);
		fireEvent.mouseEnter(screen.getByRole("button", { name: /Large/ }));
		await waitFor(() => expect(screen.getByText("large preview text")).toBeTruthy());
		fireEvent.mouseLeave(screen.getByRole("button", { name: /Large/ }));
		await waitFor(() => expect(screen.queryByText("large preview text")).toBeNull());
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
		expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(false);
		act(() => appStore.set(activeAgentIdAtom, "session-b"));
		expect(screen.getByTestId("active-session").textContent).toBe("session-b");
		await waitFor(() => expect(screen.queryByText("规划问题")).toBeNull());
		act(() => appStore.set(activeAgentIdAtom, "session-a"));
		await waitFor(() =>
			expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(false),
		);
	});

	it("combines multi-select labels with a custom Other answer", async () => {
		appStore.set(planQuestionRequestAtomFamily("session-a"), {
			...questionRequest,
			questions: [{ ...questionRequest.questions[0], multiSelect: true }],
		});
		renderWithStore(<ActivePlanQuestionDialog />);
		fireEvent.click(screen.getByRole("button", { name: /Small/ }));
		fireEvent.click(screen.getByRole("button", { name: /Other\.\.\./ }));
		fireEvent.change(screen.getByPlaceholderText("Type a custom answer..."), { target: { value: "Custom" } });
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
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
		fireEvent.click(screen.getByRole("button", { name: "Approve & execute" }));
		await waitFor(() =>
			expect(respondPlanApproval).toHaveBeenCalledWith({
				requestId: "approval-1",
				sessionId: "session-a",
				action: "approve",
			}),
		);
		expect(appStore.get(permissionModeAtomFamily("session-a"))).toBe("always");
	});
});
