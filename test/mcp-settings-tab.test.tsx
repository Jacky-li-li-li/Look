// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import McpServersTab from "../src/renderer/components/settings/McpServersTab";
import i18n from "../src/renderer/i18n";
import { mcpStatusVersionAtom } from "../src/renderer/store/atoms";
import { appStore } from "../src/renderer/store/ipcHandler";

describe("McpServersTab", () => {
	const listMcpServers = vi.fn();
	const listMcpTools = vi.fn();
	const toggleMcpServer = vi.fn();
	const removeMcpServer = vi.fn();

	beforeEach(async () => {
		await i18n.changeLanguage("en");
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
		removeMcpServer.mockReset().mockResolvedValue({ success: true });
		listMcpTools.mockReset().mockResolvedValue({ success: true, tools: [] });
		Object.defineProperty(window, "look", {
			configurable: true,
			value: {
				listMcpServers,
				listMcpTools,
				toggleMcpServer,
				testMcpServer: vi.fn(),
				removeMcpServer,
			},
		});
	});

	function renderTab() {
		return render(
			<Provider store={appStore}>
				<I18nextProvider i18n={i18n}>
					<McpServersTab />
				</I18nextProvider>
			</Provider>,
		);
	}

	afterEach(() => {
		cleanup();
		appStore.set(mcpStatusVersionAtom, 0);
	});

	it("updates the switch state immediately while toggle IPC is still pending", async () => {
		renderTab();

		await screen.findByText("filesystem");
		const toggle = screen.getByRole("switch", { name: "Enable" });
		expect(toggle.getAttribute("aria-checked")).toBe("false");

		fireEvent.click(toggle);

		await waitFor(() => expect(toggleMcpServer).toHaveBeenCalledWith("filesystem", true));
		expect(toggle.getAttribute("aria-checked")).toBe("true");
	});

	it("does not expand the server card when the switch is clicked", async () => {
		renderTab();

		await screen.findByText("filesystem");
		fireEvent.click(screen.getByRole("switch", { name: "Enable" }));

		await waitFor(() => expect(toggleMcpServer).toHaveBeenCalledWith("filesystem", true));
		expect(listMcpTools).not.toHaveBeenCalled();
		expect(screen.queryByText("This server does not provide any tools")).toBeNull();
	});

	it("keeps the optimistic switch state when a stale status refresh arrives while pending", async () => {
		renderTab();

		await screen.findByText("filesystem");
		const toggle = screen.getByRole("switch", { name: "Enable" });
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

	it("requires confirmation before deleting a server", async () => {
		renderTab();
		await screen.findByText("filesystem");

		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(removeMcpServer).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog", { name: "Delete MCP server?" })).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(removeMcpServer).toHaveBeenCalledWith("filesystem"));
	});
});
