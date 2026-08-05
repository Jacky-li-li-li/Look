// @vitest-environment jsdom

// ============================================================
// ApiKeysTab — minimal integration tests for built-in provider
// key management. window.look is a full mock; no real IPC/storage
// or network calls are made.
// ============================================================

import { TooltipProvider } from "@look/ui/components/ui/tooltip";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomProviderStats, ProviderInfo } from "../src/renderer/components/settings/types";
import i18n from "../src/renderer/i18n";

const providers: ProviderInfo[] = [
	{ id: "anthropic", name: "Anthropic", hasKey: false, modelsAvailable: 3, hasLogin: false, supportsApiKey: true },
	{ id: "openai", name: "OpenAI", hasKey: true, modelsAvailable: 2, hasLogin: false, supportsApiKey: true },
	{
		id: "moonshotai",
		name: "Moonshot AI",
		hasKey: true,
		modelsAvailable: 10,
		hasLogin: false,
		supportsApiKey: true,
		authSource: "environment",
		envLabel: "MOONSHOT_API_KEY",
		envVar: "MOONSHOT_API_KEY",
	},
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
				<TooltipProvider>
					<ApiKeysTab
						providers={providers}
						customProviders={[]}
						customStats={customStats}
						onProvidersChange={onProvidersChange}
					/>
				</TooltipProvider>
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

	it("reveals the real key on demand when the user clicks the eye toggle", async () => {
		// 默认返回掩码；仅当显式 reveal 时返回明文
		getApiKey.mockImplementation((provider: string, opts?: { reveal?: boolean }) =>
			Promise.resolve({
				success: true,
				key: opts?.reveal ? "sk-real-secret-1234" : "sk-••••1234",
				masked: !opts?.reveal,
			}),
		);
		renderTab();

		await screen.findByText("OpenAI", { selector: "span" });
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));

		const input = (await screen.findByPlaceholderText("sk-...")) as HTMLInputElement;
		await waitFor(() => expect(getApiKey).toHaveBeenCalledWith("openai"));
		expect(input.value).toBe("sk-••••1234");

		// 点击显示 → 按需请求明文
		fireEvent.click(screen.getByRole("button", { name: "Show key" }));
		await waitFor(() => expect(getApiKey).toHaveBeenCalledWith("openai", { reveal: true }));
		await waitFor(() => expect(input.value).toBe("sk-real-secret-1234"));
		expect(screen.getByRole("button", { name: "Copy key" })).toBeTruthy();

		// 再次点击隐藏 → 未改动时恢复掩码
		fireEvent.click(screen.getByRole("button", { name: "Hide key" }));
		await waitFor(() => expect(input.value).toBe("sk-••••1234"));
	});

	it("copies the revealed key to the clipboard", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		try {
			getApiKey.mockImplementation((provider: string, opts?: { reveal?: boolean }) =>
				Promise.resolve({
					success: true,
					key: opts?.reveal ? "sk-real-secret-1234" : "sk-••••1234",
					masked: !opts?.reveal,
				}),
			);
			renderTab();

			await screen.findByText("OpenAI", { selector: "span" });
			fireEvent.click(screen.getByRole("button", { name: "Edit" }));
			await screen.findByPlaceholderText("sk-...");
			fireEvent.click(screen.getByRole("button", { name: "Show key" }));
			await waitFor(() => screen.getByRole("button", { name: "Copy key" }));

			fireEvent.click(screen.getByRole("button", { name: "Copy key" }));
			await waitFor(() => expect(writeText).toHaveBeenCalledWith("sk-real-secret-1234"));
		} finally {
			Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
		}
	});

	it("shows only the env badge for environment-sourced providers (no edit/add/clear buttons)", async () => {
		renderTab();

		await screen.findByText("Moonshot AI");
		const row = screen.getByText("Moonshot AI").closest(".relative.overflow-hidden");
		expect(row).not.toBeNull();

		// env 来源：无编辑/添加/清除按钮，徽标即最终状态
		expect(within(row!).queryByRole("button", { name: /edit|add key|clear/i })).toBeNull();

		// 环境变量徽标显示，title 为 env 变量名
		const badge = within(row!).getByText("Environment variable");
		expect(badge.title).toBe("MOONSHOT_API_KEY");

		// 其他 provider 的编辑/添加按钮不受影响
		expect(screen.getByRole("button", { name: "Add key" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
	});
});
