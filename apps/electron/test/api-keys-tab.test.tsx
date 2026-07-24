// @vitest-environment jsdom

// ============================================================
// ApiKeysTab — minimal integration tests for built-in provider
// key management. window.look is a full mock; no real IPC/storage
// or network calls are made.
// ============================================================

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomProviderStats, ProviderInfo } from "../src/renderer/components/settings/types";
import i18n from "../src/renderer/i18n";

const providers: ProviderInfo[] = [
	{ id: "anthropic", name: "Anthropic", hasKey: false, modelsAvailable: 3 },
	{ id: "openai", name: "OpenAI", hasKey: true, modelsAvailable: 2 },
];

const customStats: CustomProviderStats = { configured: 0, totalModels: 0 };

// ApiKeysTab captures `window.look` into a module-level `const api` at
// import time. Since ESM `import` statements are hoisted above the rest
// of a test file's top-level code, a static import would run before
// beforeEach ever gets to install the window.look mock, leaving `api`
// permanently undefined. Installing the mock first and then
// dynamic-importing the component (once) sidesteps that ordering issue.
const listCustomProviders = vi.fn();
const getApiKey = vi.fn();
const testApiKey = vi.fn();
const setApiKey = vi.fn();

Object.defineProperty(window, "look", {
	configurable: true,
	value: {
		listCustomProviders,
		getApiKey,
		testApiKey,
		setApiKey,
		removeCustomProvider: vi.fn(),
		getSettings: vi.fn(),
	},
});

describe("ApiKeysTab", () => {
	let ApiKeysTab: typeof import("../src/renderer/components/settings/ApiKeysTab").default;
	const onProvidersChange = vi.fn();

	beforeAll(async () => {
		ApiKeysTab = (await import("../src/renderer/components/settings/ApiKeysTab")).default;
	});

	beforeEach(async () => {
		await i18n.changeLanguage("en");

		listCustomProviders.mockReset().mockResolvedValue({ success: true, providers: [] });
		getApiKey.mockReset().mockResolvedValue({ success: true, key: "sk-existing" });
		testApiKey.mockReset().mockResolvedValue({ success: true, result: { ok: true } });
		setApiKey.mockReset().mockResolvedValue({
			success: true,
			providers: providers.map((p) => (p.id === "anthropic" ? { ...p, hasKey: true } : p)),
			customProviders: [],
			customStats,
		});
		onProvidersChange.mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	function renderTab() {
		return render(
			<I18nextProvider i18n={i18n}>
				<ApiKeysTab
					providers={providers}
					customProviders={[]}
					customStats={customStats}
					onProvidersChange={onProvidersChange}
				/>
			</I18nextProvider>,
		);
	}

	it("opens the built-in provider editor and saves a new key via test-and-save", async () => {
		renderTab();

		await screen.findByText("Anthropic");
		fireEvent.click(screen.getByRole("button", { name: "Add key" }));

		const input = await screen.findByPlaceholderText("sk-...");
		fireEvent.change(input, { target: { value: "sk-new-key-123" } });
		fireEvent.click(screen.getByRole("button", { name: "Test & save" }));

		await waitFor(() => expect(testApiKey).toHaveBeenCalledWith("anthropic", "sk-new-key-123"));
		await waitFor(() => expect(setApiKey).toHaveBeenCalledWith("anthropic", "sk-new-key-123"));
	});

	it("loads the stored key when opening the editor for a provider that already has one", async () => {
		renderTab();

		await screen.findByText("OpenAI", { selector: "span" });
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));

		await waitFor(() => expect(getApiKey).toHaveBeenCalledWith("openai"));
	});
});
