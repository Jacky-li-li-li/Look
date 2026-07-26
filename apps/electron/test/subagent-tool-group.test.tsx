// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import SubagentToolGroup from "../src/renderer/components/chat/SubagentToolGroup";
import type { ToolCallViewModel } from "../src/renderer/components/chat/ToolCallCard";
import i18n from "../src/renderer/i18n";
import { resetPeepAssignmentsForTest } from "../src/renderer/lib/subagentAvatars";

afterEach(cleanup);

beforeEach(async () => {
	await i18n.changeLanguage("en");
	resetPeepAssignmentsForTest();
});

function makeCall(callId: string, title: string, status: ToolCallViewModel["status"] = "success"): ToolCallViewModel {
	return {
		callId,
		toolName: "subagent",
		args: { agent: "reviewer", title, task: `task of ${title}` },
		status,
	};
}

function renderGroup(calls: ToolCallViewModel[]) {
	return render(
		<I18nextProvider i18n={i18n}>
			<SubagentToolGroup calls={calls} />
		</I18nextProvider>,
	);
}

describe("SubagentToolGroup", () => {
	it("默认展开：直接显示卡片与头部计数，无 ToolCallCard 行", () => {
		const { container, getByText, queryByText } = renderGroup([
			makeCall("c1", "架构深度分析"),
			makeCall("c2", "渲染进程分析"),
		]);
		expect(getByText("2 subagents")).toBeTruthy();
		expect(getByText("架构深度分析")).toBeTruthy();
		expect(getByText("渲染进程分析")).toBeTruthy();
		// 不经过 ToolCallCard：没有工具名行与 Arguments JSON 区
		expect(queryByText("subagent")).toBeNull();
		expect(queryByText("Arguments")).toBeNull();
		expect(container.querySelector("[data-tool-panel]")).toBeNull();
	});

	it("点击头部可折叠/展开", () => {
		const { container, getByRole } = renderGroup([makeCall("c1", "架构深度分析")]);
		const trigger = getByRole("button", { name: /subagents/ });
		const body = container.querySelector("[data-subagent-group-body]");
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(body?.getAttribute("data-open")).toBe("true");
		fireEvent.click(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(body?.getAttribute("data-open")).toBe("false");
		fireEvent.click(trigger);
		expect(body?.getAttribute("data-open")).toBe("true");
	});

	it("卡片显示执行状态徽章", () => {
		const { getByText } = renderGroup([makeCall("c1", "架构深度分析", "running")]);
		expect(getByText("running")).toBeTruthy();
	});

	it("args 未完整（流式早期）的调用被跳过", () => {
		const partial: ToolCallViewModel = {
			callId: "c-partial",
			toolName: "subagent",
			args: { agent: "rev" }, // 缺 task/title
			status: "running",
		};
		const { getByText, queryByText } = renderGroup([partial, makeCall("c1", "架构深度分析")]);
		expect(getByText("1 subagents")).toBeTruthy();
		expect(queryByText("rev")).toBeNull();
	});

	it("点击卡片弹窗展示任务简报（路由眉毛 + 头像 + task）", async () => {
		renderGroup([makeCall("c1", "架构深度分析")]);
		const card = screen.getAllByRole("button").find((b) => b.textContent?.includes("reviewer"));
		fireEvent.click(card!);
		// 路由带眉毛：Task brief → reviewer
		const dialog = await screen.findByRole("dialog");
		expect(dialog.textContent).toContain("Task brief");
		expect(dialog.textContent).toContain("reviewer");
		// 标题（卡片 + 弹窗各一处）与简报正文
		expect(screen.getAllByText("架构深度分析").length).toBeGreaterThanOrEqual(2);
		expect(await screen.findByText("task of 架构深度分析")).toBeTruthy();
	});
});
