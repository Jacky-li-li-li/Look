// @vitest-environment jsdom

// ============================================================
// ModelSelector — first-frame stability regression tests.
// The model catalog arrives asynchronously from the main process; the
// toolbar must still expose the current model key before that request
// settles. ChatPanel remounts on every agent switch (key=agentId), so
// the catalog cache must survive remounts — otherwise the model row
// flickers between "model-key" and the catalog name on new sessions.
// ============================================================

import type { AvailableModel } from "@shared/types";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/renderer/i18n";

const getModels = vi.fn();
const switchModel = vi.fn();

Object.defineProperty(window, "look", {
	configurable: true,
	value: {
		getModels,
		switchModel,
	},
});

const model = (overrides: Partial<AvailableModel>): AvailableModel => ({
	provider: "deepseek",
	id: "deepseek-v4-pro",
	name: "DeepSeek V4 Pro",
	reasoning: true,
	contextWindow: 128_000,
	maxTokens: 8_192,
	cost: { input: 0, output: 0 },
	...overrides,
});

describe("ModelSelector first-frame model display", () => {
	let ModelSelector: typeof import("../src/renderer/components/chat/ModelSelector").default;

	beforeEach(async () => {
		// The catalog cache is module-level; reload the module to isolate cases.
		vi.resetModules();
		ModelSelector = (await import("../src/renderer/components/chat/ModelSelector")).default;
		await i18n.changeLanguage("en");
		getModels.mockReset();
		switchModel.mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	function renderSelector(currentModel: string) {
		return render(
			<I18nextProvider i18n={i18n}>
				<Provider store={createStore()}>
					<ModelSelector agentId="agent-1" currentModel={currentModel} />
				</Provider>
			</I18nextProvider>,
		);
	}

	it("catalog pending: renders the current model key immediately, then upgrades to the catalog name", async () => {
		let resolveModels: ((value: { success: true; models: AvailableModel[] }) => void) | undefined;
		getModels.mockReturnValue(
			new Promise((resolve) => {
				resolveModels = resolve;
			}),
		);

		renderSelector("deepseek/deepseek-v4-pro");
		const button = await screen.findByRole("button");
		expect(button.textContent).toContain("deepseek-v4-pro");
		expect(button.className).toContain("max-w-[24rem]");

		resolveModels?.({ success: true, models: [model({})] });
		await waitFor(() => expect(button.textContent).toContain("DeepSeek V4 Pro"));
	});

	it("remount (new session / agent switch) shows the catalog name on the first frame — no key flicker", async () => {
		getModels.mockResolvedValue({ success: true, models: [model({})] });
		const first = renderSelector("deepseek/deepseek-v4-pro");
		const button = await screen.findByRole("button");
		await waitFor(() => expect(button.textContent).toContain("DeepSeek V4 Pro"));

		// Simulate ChatPanel remount: the catalog request is now pending forever
		// (as if it restarted from scratch). The module cache must make the new
		// instance render the full name synchronously on its first frame.
		getModels.mockReturnValue(new Promise<never>(() => {}));
		first.unmount();
		cleanup();

		renderSelector("deepseek/deepseek-v4-pro");
		const remounted = await screen.findByRole("button");
		expect(remounted.textContent).toContain("DeepSeek V4 Pro");
		expect(remounted.textContent).not.toContain("deepseek-v4-pro");
		// Cache hit: no fresh IPC round-trip needed on remount.
		expect(getModels).toHaveBeenCalledTimes(1);
	});

	it("a changed model key never keeps the previous catalog name", async () => {
		getModels.mockResolvedValue({ success: true, models: [model({})] });
		const view = renderSelector("deepseek/deepseek-v4-pro");
		const button = await screen.findByRole("button");
		await waitFor(() => expect(button.textContent).toContain("DeepSeek V4 Pro"));

		view.rerender(
			<I18nextProvider i18n={i18n}>
				<Provider store={createStore()}>
					<ModelSelector agentId="agent-1" currentModel="openai/gpt-5.5" />
				</Provider>
			</I18nextProvider>,
		);
		await waitFor(() => expect(button.textContent).toContain("gpt-5.5"));
		expect(button.textContent).not.toContain("DeepSeek V4 Pro");
	});
});
