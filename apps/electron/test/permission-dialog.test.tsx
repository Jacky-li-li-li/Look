// @vitest-environment jsdom

import type { AgentInfo, PermissionAskQueueItem } from "@shared/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PermissionDialog from "../src/renderer/components/dialogs/PermissionDialog";
import { appStore } from "../src/renderer/store/appStore";
import { agentsAtom, permissionAskQueueAtom } from "../src/renderer/store/atoms";

const emptyUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const agents: AgentInfo[] = [
	{
		id: "session-a",
		name: "Session A",
		model: "test/model",
		thinkingLevel: "off",
		status: "idle",
		messageCount: 1,
		createdAt: 1,
		usage: emptyUsage,
	},
	{
		id: "session-b",
		name: "Session B",
		model: "test/model",
		thinkingLevel: "off",
		status: "idle",
		messageCount: 1,
		createdAt: 2,
		usage: emptyUsage,
	},
];

function request(requestId: string, agentId: string, toolName = "write"): PermissionAskQueueItem {
	return {
		requestId,
		agentId,
		toolName,
		toolInput: { path: "test.txt" },
		toolDescription: `Tool: ${toolName}`,
		expiresAt: Date.now() + 30_000,
	};
}

function renderDialog() {
	return render(
		<Provider store={appStore}>
			<PermissionDialog />
		</Provider>,
	);
}

describe("permission dialog", () => {
	const respondPermission = vi.fn();

	beforeEach(() => {
		respondPermission.mockReset();
		respondPermission.mockResolvedValue({ success: true });
		Object.defineProperty(window, "look", {
			configurable: true,
			value: { respondPermission },
		});
		appStore.set(agentsAtom, agents);
		appStore.set(permissionAskQueueAtom, []);
	});

	afterEach(() => {
		cleanup();
		appStore.set(permissionAskQueueAtom, []);
	});

	it("does not turn Enter on the focused deny button into an allow decision", async () => {
		appStore.set(permissionAskQueueAtom, [request("request-a", "session-a")]);
		renderDialog();
		const deny = screen.getByRole("button", { name: "Deny (Esc)" });
		deny.focus();
		fireEvent.keyDown(deny, { key: "Enter" });
		expect(respondPermission).not.toHaveBeenCalled();

		fireEvent.click(deny);
		await waitFor(() => expect(respondPermission).toHaveBeenCalledWith({ requestId: "request-a", action: "deny" }));
	});

	it("keeps concurrent requests queued and identifies their sessions", async () => {
		appStore.set(permissionAskQueueAtom, [
			request("request-a", "session-a"),
			request("request-b", "session-b", "mcp:github:create_issue"),
		]);
		renderDialog();
		expect(screen.getByText(/Session A/)).toBeTruthy();
		expect(screen.getByText(/1 more request\(s\) queued/)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() => expect(screen.getByText(/Session B/)).toBeTruthy());
		expect(screen.getByText("mcp:github:create_issue")).toBeTruthy();
	});
});
