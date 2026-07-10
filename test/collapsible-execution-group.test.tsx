// @vitest-environment jsdom

import { I18nextProvider } from "react-i18next";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CollapsibleExecutionGroup from "../src/renderer/components/CollapsibleExecutionGroup";
import i18n from "../src/renderer/i18n";
import type { LookUiToolExecState } from "@shared/types";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

beforeEach(async () => {
	await i18n.changeLanguage("en");
});

function makeToolCall(id: string, name = "bash", args: Record<string, unknown> = {}) {
	// The SDK's ToolCall discriminator is "toolCall"; cast keeps the helper terse.
	return { type: "toolCall" as const, id, name, arguments: args };
}

function makeThinking(text: string) {
	return { type: "thinking" as const, thinking: text };
}

function completedExec(toolCallId: string, toolName = "bash"): LookUiToolExecState {
	return {
		toolCallId,
		toolName,
		args: {},
		phase: "completed",
		result: "ok",
		isError: false,
	};
}

function runningExec(toolCallId: string, toolName = "bash"): LookUiToolExecState {
	return {
		toolCallId,
		toolName,
		args: {},
		phase: "running",
		partialResult: "",
		isError: false,
	};
}

function renderGroup(props: Partial<React.ComponentProps<typeof CollapsibleExecutionGroup>> = {}) {
	const blocks = props.blocks ?? [];
	const inlineTexts = props.inlineTexts ?? [];
	const toolExecutions = props.toolExecutions ?? {};
	const toolResultMap = props.toolResultMap ?? {};
	return render(
		<I18nextProvider i18n={i18n}>
			<CollapsibleExecutionGroup
				blocks={blocks}
				inlineTexts={inlineTexts}
				toolExecutions={toolExecutions}
				toolResultMap={toolResultMap}
				isStreaming={props.isStreaming ?? false}
			/>
		</I18nextProvider>,
	);
}

describe("CollapsibleExecutionGroup", () => {
	it("collapses a single completed tool into a singular badge", () => {
		const { container } = renderGroup({
			blocks: [makeToolCall("t1")],
			toolExecutions: { t1: completedExec("t1") },
		});
		const text = container.textContent ?? "";
		// Even a single tool now produces a badge — no more inline escape.
		expect(text).toMatch(/Executed 1 tool/i);
	});

	it("renders a badge for 3 completed tools", () => {
		const blocks = [
			makeToolCall("t1", "bash", { command: "ls" }),
			makeToolCall("t2", "read", { path: "/etc/hosts" }),
			makeToolCall("t3", "bash", { command: "pwd" }),
		];
		const toolExecutions = {
			t1: completedExec("t1"),
			t2: completedExec("t2"),
			t3: completedExec("t3"),
		};
		const { container } = renderGroup({ blocks, toolExecutions });
		const text = container.textContent ?? "";
		expect(text).toMatch(/Executed 3 tools/i);
	});

	it("renders badge for 5 completed tools", () => {
		const blocks = [1, 2, 3, 4, 5].map((n) => makeToolCall(`t${n}`));
		const toolExecutions = Object.fromEntries(blocks.map((b) => [b.id, completedExec(b.id)]));
		const { container } = renderGroup({ blocks, toolExecutions });
		const text = container.textContent ?? "";
		expect(text).toMatch(/Executed 5 tools/i);
	});

	it("collapses a single completed thinking block into a singular badge", () => {
		const { container } = renderGroup({
			blocks: [makeThinking("I should run ls first.")],
		});
		const text = container.textContent ?? "";
		// No more "Reasoning" inline fallback — single thinking → singular badge.
		expect(text).toMatch(/Thought 1 time/i);
	});

	it("renders mixed badge for 2 thinking + 3 tools all completed", () => {
		const blocks = [
			makeThinking("Plan: read the file then list it."),
			makeThinking("Continue plan."),
			makeToolCall("t1", "read", { path: "/a" }),
			makeToolCall("t2", "bash", { command: "ls" }),
			makeToolCall("t3", "bash", { command: "pwd" }),
		];
		const toolExecutions = {
			t1: completedExec("t1"),
			t2: completedExec("t2"),
			t3: completedExec("t3"),
		};
		const { container } = renderGroup({ blocks, toolExecutions });
		const text = container.textContent ?? "";
		expect(text).toMatch(/2 thoughts, 3 tool calls/i);
	});

	it("forces expanded state when any block is running (badge stays aria-expanded=true, cards visible)", () => {
		const blocks = [
			makeToolCall("t1", "bash", { command: "ls" }),
			makeToolCall("t2", "read", { path: "/a" }),
			makeToolCall("t3", "bash", { command: "pwd" }),
		];
		const toolExecutions = {
			t1: completedExec("t1"),
			t2: runningExec("t2"), // ← still running
			t3: completedExec("t3"),
		};
		const { container, getByText } = renderGroup({ blocks, toolExecutions });
		const text = container.textContent ?? "";
		// Cards must be visible (we want to see live progress).
		expect(text).toContain("read");
		// Badge stays in the open state — users can still collapse manually
		// after the run finishes; the badge click toggles open ↔ closed.
		const badgeBtn = getByText(/Executed 3 tools/i).closest("button")!;
		expect(badgeBtn.getAttribute("aria-expanded")).toBe("true");
	});

	it("toggles badge into underlying cards when clicked, then collapses again on second click", () => {
		vi.useFakeTimers();
		const blocks = [
			makeToolCall("t1", "bash", { command: "ls" }),
			makeToolCall("t2", "read", { path: "/a" }),
			makeToolCall("t3", "bash", { command: "pwd" }),
		];
		const toolExecutions = {
			t1: completedExec("t1"),
			t2: completedExec("t2"),
			t3: completedExec("t3"),
		};
		const { container, getByText } = renderGroup({ blocks, toolExecutions });

		// First click → expanded: tool names visible, badge still present
		const badgeBtn = getByText(/Executed 3 tools/i).closest("button")!;
		fireEvent.click(badgeBtn);
		let text = container.textContent ?? "";
		expect(text).toContain("bash");
		expect(text).toContain("read");
		expect(text).toMatch(/Executed 3 tools/i);
		expect(badgeBtn.getAttribute("aria-expanded")).toBe("true");

		// Second click on the SAME trigger → collapses back: tool bodies gone,
		// only the badge remains (no extra Collapse button).
		fireEvent.click(badgeBtn);
		text = container.textContent ?? "";
		expect(text).toMatch(/Executed 3 tools/i);
		expect(badgeBtn.getAttribute("aria-expanded")).toBe("false");
		act(() => {
			vi.advanceTimersByTime(220);
		});
		text = container.textContent ?? "";
		// No standalone "Collapse" text below the badge
		expect(container.querySelectorAll("button").length).toBe(1);
	});

	it("uses singular form for 1 tool (default behaviour)", () => {
		const blocks = [makeToolCall("t1", "bash", { command: "ls" })];
		const toolExecutions = { t1: completedExec("t1") };
		const { container } = renderGroup({ blocks, toolExecutions });
		const text = container.textContent ?? "";
		expect(text).toMatch(/Executed 1 tool/i);
	});

	it("renders Chinese singular/plural correctly", async () => {
		await i18n.changeLanguage("zh");
		const blocks = [makeToolCall("t1", "bash", { command: "ls" })];
		const toolExecutions = { t1: completedExec("t1") };
		const { container } = renderGroup({ blocks, toolExecutions });
		const text = container.textContent ?? "";
		expect(text).toContain("执行了 1 个工具");
	});

	it("renders Chinese plural for 3 tools", async () => {
		await i18n.changeLanguage("zh");
		const blocks = [makeToolCall("t1"), makeToolCall("t2"), makeToolCall("t3")];
		const toolExecutions = {
			t1: completedExec("t1"),
			t2: completedExec("t2"),
			t3: completedExec("t3"),
		};
		const { container } = renderGroup({ blocks, toolExecutions });
		const text = container.textContent ?? "";
		expect(text).toContain("执行了 3 个工具");
	});

	it("renders inlineTexts interleaved with cards when expanded via click", () => {
		const blocks = [
			makeToolCall("t1", "bash", { command: "ls" }),
			makeToolCall("t2", "read", { path: "/a" }),
			makeToolCall("t3", "bash", { command: "pwd" }),
		];
		const toolExecutions = {
			t1: completedExec("t1"),
			t2: completedExec("t2"),
			t3: completedExec("t3"),
		};
		const inlineTexts = ["看核心执行部分：", "看子进程启动的关键函数："];
		const { container, getByText } = renderGroup({
			blocks,
			inlineTexts,
			toolExecutions,
		});

		// Click to expand
		const badgeBtn = getByText(/Executed 3 tools/i).closest("button")!;
		fireEvent.click(badgeBtn);

		const text = container.textContent ?? "";
		// Both inline notes must be visible after expansion
		expect(text).toContain("看核心执行部分：");
		expect(text).toContain("看子进程启动的关键函数：");
		// Tools are also visible
		expect(text).toContain("bash");
		expect(text).toContain("read");
	});

	it("does not show inlineTexts when collapsed as badge (badge alone)", () => {
		const blocks = [makeToolCall("t1"), makeToolCall("t2"), makeToolCall("t3")];
		const toolExecutions = {
			t1: completedExec("t1"),
			t2: completedExec("t2"),
			t3: completedExec("t3"),
		};
		const inlineTexts = ["看核心执行部分："];
		const { container } = renderGroup({ blocks, inlineTexts, toolExecutions });
		const text = container.textContent ?? "";
		// Collapsed badge state: only summary visible, inline text is hidden
		expect(text).toMatch(/Executed 3 tools/i);
		expect(text).not.toContain("看核心执行部分：");
	});

	it("keeps an active streaming group expanded, then auto-collapses after the batched delay", () => {
		vi.useFakeTimers();
		const blocks = [makeToolCall("t1", "bash", { command: "ls" })];
		const toolExecutions = { t1: completedExec("t1") };
		const { getByText, rerender } = renderGroup({ blocks, toolExecutions, isStreaming: true });
		const badgeBtn = getByText(/Executed 1 tool/i).closest("button")!;

		expect(badgeBtn.getAttribute("aria-expanded")).toBe("true");
		expect(document.querySelector("[data-execution-group-body]")?.getAttribute("data-open")).toBe("true");

		rerender(
			<I18nextProvider i18n={i18n}>
				<CollapsibleExecutionGroup
					blocks={blocks}
					inlineTexts={[]}
					toolExecutions={toolExecutions}
					toolResultMap={{}}
					isStreaming={false}
				/>
			</I18nextProvider>,
		);

		expect(badgeBtn.getAttribute("aria-expanded")).toBe("true");
		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(badgeBtn.getAttribute("aria-expanded")).toBe("false");
		expect(document.querySelector("[data-execution-group-body]")?.getAttribute("data-open")).toBe("false");
	});
});
