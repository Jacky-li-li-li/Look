// @vitest-environment jsdom

import type { LookUiToolExecState } from "@shared/types";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CollapsibleExecutionGroup from "../src/renderer/components/chat/CollapsibleExecutionGroup";
import i18n from "../src/renderer/i18n";

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

function getBadgeBtn(container: HTMLElement) {
	// The count digits live in nested rolling spans, so text-based queries
	// can't match the whole label — grab the trigger by structure instead.
	return container.querySelector("[data-execution-group] > button") as HTMLButtonElement;
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

	it("keeps a running group collapsed until the user expands it", () => {
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
		const { container } = renderGroup({ blocks, toolExecutions });
		const badgeBtn = getBadgeBtn(container);
		const body = container.querySelector("[data-execution-group-body]")!;
		expect(badgeBtn.getAttribute("aria-expanded")).toBe("false");
		expect(body.getAttribute("aria-hidden")).toBe("true");

		fireEvent.click(badgeBtn);
		expect(badgeBtn.getAttribute("aria-expanded")).toBe("true");
		expect(body.getAttribute("aria-hidden")).toBe("false");
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
		const { container } = renderGroup({ blocks, toolExecutions });

		// First click → expanded: tool names visible, badge still present
		const badgeBtn = getBadgeBtn(container);
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
		// No standalone group-level "Collapse" control below the badge.
		expect(container.querySelectorAll(":scope > [data-execution-group] > button").length).toBe(1);
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
		const { container } = renderGroup({
			blocks,
			inlineTexts,
			toolExecutions,
		});

		// Click to expand
		const badgeBtn = getBadgeBtn(container);
		fireEvent.click(badgeBtn);

		const text = container.textContent ?? "";
		// Both inline notes must be visible after expansion
		expect(text).toContain("看核心执行部分：");
		expect(text).toContain("看子进程启动的关键函数：");
		// Tools are also visible
		expect(text).toContain("bash");
		expect(text).toContain("read");
	});

	it("marks the mounted group body hidden while collapsed", () => {
		const blocks = [makeToolCall("t1"), makeToolCall("t2"), makeToolCall("t3")];
		const toolExecutions = {
			t1: completedExec("t1"),
			t2: completedExec("t2"),
			t3: completedExec("t3"),
		};
		const inlineTexts = ["看核心执行部分："];
		const { container } = renderGroup({ blocks, inlineTexts, toolExecutions });
		expect(container.textContent ?? "").toMatch(/Executed 3 tools/i);
		const body = container.querySelector("[data-execution-group-body]")!;
		expect(body.getAttribute("aria-hidden")).toBe("true");
		expect(body.getAttribute("data-open")).toBe("false");
	});

	it("preserves the user's manual expansion when streaming ends", () => {
		const blocks = [makeToolCall("t1", "bash", { command: "ls" })];
		const toolExecutions = { t1: completedExec("t1") };
		const { container, rerender } = renderGroup({ blocks, toolExecutions, isStreaming: true });
		const badgeBtn = getBadgeBtn(container);

		expect(badgeBtn.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(badgeBtn);
		expect(badgeBtn.getAttribute("aria-expanded")).toBe("true");

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
		expect(document.querySelector("[data-execution-group-body]")?.getAttribute("data-open")).toBe("true");
	});

	it("rolls the badge number when the tool count changes", () => {
		const rollingSpan = (container: HTMLElement) =>
			container.querySelector('[data-execution-group] > button span[class*="roll-in"]');

		const blocks3 = [makeToolCall("t1"), makeToolCall("t2"), makeToolCall("t3")];
		const exec3 = Object.fromEntries(blocks3.map((b) => [b.id, completedExec(b.id)]));
		const { container, rerender } = renderGroup({ blocks: blocks3, toolExecutions: exec3 });
		expect(container.textContent ?? "").toMatch(/Executed 3 tools/i);
		expect(rollingSpan(container)?.textContent).toBe("3");

		const blocks4 = [...blocks3, makeToolCall("t4")];
		const exec4 = { ...exec3, t4: completedExec("t4") };
		rerender(
			<I18nextProvider i18n={i18n}>
				<CollapsibleExecutionGroup
					blocks={blocks4}
					inlineTexts={[]}
					toolExecutions={exec4}
					toolResultMap={{}}
					isStreaming={false}
				/>
			</I18nextProvider>,
		);
		expect(container.textContent ?? "").toMatch(/Executed 4 tools/i);
		expect(rollingSpan(container)?.textContent).toBe("4");
	});
});
