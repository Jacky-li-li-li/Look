// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import McpServersTab from "../src/renderer/components/settings/McpServersTab";
import { mcpStatusVersionAtom } from "../src/renderer/store/atoms";
import { appStore } from "../src/renderer/store/ipcHandler";

describe("McpServersTab", () => {
	const listMcpServers = vi.fn();
	const listMcpTools = vi.fn();
	const toggleMcpServer = vi.fn();

	beforeEach(() => {
		listMcpServers.mockReset().mockResolvedValue({
			success: true,
			servers: [
				{
					name: "filesystem",
					type: "stdio",
					enabled: false,
					connected: false,
					toolCount: 0,
				},
			],
		});
		toggleMcpServer.mockReset().mockReturnValue(new Promise(() => undefined));
		listMcpTools.mockReset().mockResolvedValue({ success: true, tools: [] });
		Object.defineProperty(window, "look", {
			configurable: true,
			value: {
				listMcpServers,
				listMcpTools,
				toggleMcpServer,
				testMcpServer: vi.fn(),
				removeMcpServer: vi.fn(),
			},
		});
	});

	afterEach(() => {
		cleanup();
		appStore.set(mcpStatusVersionAtom, 0);
	});

	it("updates the switch state immediately while toggle IPC is still pending", async () => {
		render(
			<Provider store={appStore}>
				<McpServersTab />
			</Provider>,
		);

		await screen.findByText("filesystem");
		const toggle = screen.getByRole("switch", { name: "启用" });
		expect(toggle.getAttribute("aria-checked")).toBe("false");

		fireEvent.click(toggle);

		await waitFor(() => expect(toggleMcpServer).toHaveBeenCalledWith("filesystem", true));
		expect(toggle.getAttribute("aria-checked")).toBe("true");
	});

	it("does not expand the server card when the switch is clicked", async () => {
		render(
			<Provider store={appStore}>
				<McpServersTab />
			</Provider>,
		);

		await screen.findByText("filesystem");
		fireEvent.click(screen.getByRole("switch", { name: "启用" }));

		await waitFor(() => expect(toggleMcpServer).toHaveBeenCalledWith("filesystem", true));
		expect(listMcpTools).not.toHaveBeenCalled();
		expect(screen.queryByText("此服务器未提供任何工具")).toBeNull();
	});

	it("keeps the optimistic switch state when a stale status refresh arrives while pending", async () => {
		render(
			<Provider store={appStore}>
				<McpServersTab />
			</Provider>,
		);

		await screen.findByText("filesystem");
		const toggle = screen.getByRole("switch", { name: "启用" });
		fireEvent.click(toggle);
		await waitFor(() => expect(toggleMcpServer).toHaveBeenCalledWith("filesystem", true));

		listMcpServers.mockResolvedValue({
			success: true,
			servers: [
				{
					name: "filesystem",
					type: "stdio",
					enabled: false,
					connected: false,
					toolCount: 0,
				},
			],
		});
		act(() => {
			appStore.set(mcpStatusVersionAtom, 1);
		});

		await waitFor(() => expect(listMcpServers).toHaveBeenCalledTimes(2));
		expect(toggle.getAttribute("aria-checked")).toBe("true");
	});
});
