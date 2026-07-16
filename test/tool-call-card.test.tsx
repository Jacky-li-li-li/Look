// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ToolCallCard, { type ToolCallViewModel } from "../src/renderer/components/chat/ToolCallCard";
import i18n from "../src/renderer/i18n";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

beforeEach(async () => {
	await i18n.changeLanguage("en");
});

function makeTool(status: ToolCallViewModel["status"]): ToolCallViewModel {
	return {
		callId: "tool-1",
		toolName: "bash",
		args: { command: "pwd" },
		status,
		result: status === "running" || status === "pending" ? undefined : "ok",
		isError: status === "error",
	};
}

function renderCard(toolCall: ToolCallViewModel) {
	return render(
		<I18nextProvider i18n={i18n}>
			<ToolCallCard toolCall={toolCall} />
		</I18nextProvider>,
	);
}

describe("ToolCallCard", () => {
	it("mounts completed history in the collapsed state", () => {
		const { getByRole } = renderCard(makeTool("success"));
		expect(getByRole("button").getAttribute("aria-expanded")).toBe("false");
	});

	it("keeps manual expansion stable when a running tool completes", () => {
		const { getByRole, rerender } = renderCard(makeTool("running"));
		const button = getByRole("button");

		expect(button.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(button);
		expect(button.getAttribute("aria-expanded")).toBe("true");

		rerender(
			<I18nextProvider i18n={i18n}>
				<ToolCallCard toolCall={makeTool("success")} />
			</I18nextProvider>,
		);

		expect(button.getAttribute("aria-expanded")).toBe("true");
		fireEvent.click(button);
		expect(button.getAttribute("aria-expanded")).toBe("false");
	});
});
