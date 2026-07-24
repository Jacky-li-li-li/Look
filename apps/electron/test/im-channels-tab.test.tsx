// @vitest-environment jsdom

// ============================================================
// ImChannelsTab — minimal integration test for the initial
// channel-load flow. Verifies the tab calls window.look.getImChannels
// on mount and renders the returned channel's connection status.
// window.look is a full mock; no real IPC/storage/network is used.
// ============================================================

import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/renderer/i18n";

// ImChannelsTab captures `window.look` into a module-level `const api`
// at import time. Since ESM `import` statements are hoisted above the
// rest of a test file's top-level code, a static import would run
// before beforeEach ever gets to install the window.look mock, leaving
// `api` permanently undefined. Installing the mock first and then
// dynamic-importing the component (once) sidesteps that ordering issue.
const getImChannels = vi.fn();
const onEvent = vi.fn();

Object.defineProperty(window, "look", {
	configurable: true,
	value: {
		getImChannels,
		onEvent,
		// Not exercised by this test, but present so any incidental
		// calls from the component don't throw on a missing method.
		connectFeishuChannel: vi.fn(),
		connectFeishuManualChannel: vi.fn(),
		cancelFeishuRegistration: vi.fn(),
		disconnectImChannel: vi.fn(),
		reconnectImChannel: vi.fn(),
		removeImChannel: vi.fn(),
		testImConnection: vi.fn(),
		testImConnectionDirect: vi.fn(),
		updateImChannel: vi.fn(),
	},
});

describe("ImChannelsTab", () => {
	let ImChannelsTab: typeof import("../src/renderer/components/settings/ImChannelsTab").default;

	beforeAll(async () => {
		ImChannelsTab = (await import("../src/renderer/components/settings/ImChannelsTab")).default;
	});

	beforeEach(async () => {
		await i18n.changeLanguage("en");

		getImChannels.mockReset().mockResolvedValue({
			success: true,
			channels: [
				{
					provider: "feishu",
					appId: "cli_a1b2c3d4e5f6",
					name: "Team Bot",
					status: "connected",
					connected: true,
					enabled: true,
				},
			],
		});
		onEvent.mockReset().mockReturnValue(() => {});
	});

	afterEach(() => {
		cleanup();
	});

	function renderTab() {
		return render(
			<I18nextProvider i18n={i18n}>
				<ImChannelsTab />
			</I18nextProvider>,
		);
	}

	it("loads channels on mount and renders the connected status for one channel", async () => {
		renderTab();

		expect(await screen.findByText("Team Bot")).toBeTruthy();
		expect(getImChannels).toHaveBeenCalledTimes(1);
		// statusBadgeKey("connected") -> "settings.feishuConnected" -> "Feishu connected"
		expect(screen.getByText("Feishu connected")).toBeTruthy();
	});
});
