// @vitest-environment jsdom

// ============================================================
// GeneralTab showToolExecution 开关 — 点击后实时同步全局 atom
//
// 回归保障：修复「关闭不生效」——开关不仅持久化，还必须更新
// showToolExecutionAtom，MessageBlockList 才能实时过滤。
// ============================================================

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Provider } from "jotai";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 必须在 GeneralTab 模块加载前就位 window.look
const mocks = vi.hoisted(() => {
	const getGeneralSettings = vi.fn().mockResolvedValue({
		success: true,
		settings: { language: "zh", showToolExecution: true },
	});
	const getModels = vi.fn().mockResolvedValue({ success: true, models: [] });
	const setGeneralSettings = vi.fn().mockResolvedValue({ success: true });
	(window as unknown as { look: unknown }).look = { getGeneralSettings, getModels, setGeneralSettings };
	return { getGeneralSettings, getModels, setGeneralSettings };
});

import GeneralTab from "../src/renderer/components/settings/GeneralTab";
import i18n from "../src/renderer/i18n";
import { appStore } from "../src/renderer/store/appStore";
import { showToolExecutionAtom } from "../src/renderer/store/settingsAtoms";

function renderTab() {
	return render(
		<Provider store={appStore}>
			<I18nextProvider i18n={i18n}>
				<GeneralTab />
			</I18nextProvider>
		</Provider>,
	);
}

describe("GeneralTab showToolExecution switch", () => {
	afterEach(() => cleanup());

	beforeEach(async () => {
		mocks.getGeneralSettings.mockClear();
		mocks.getModels.mockClear();
		mocks.setGeneralSettings.mockClear();
		await i18n.changeLanguage("zh");
		act(() => appStore.set(showToolExecutionAtom, true));
	});

	it("点击开关后同步全局 atom 并持久化", async () => {
		const { findByRole } = renderTab();
		// getGeneralSettings 异步回填后开关出现
		const sw = (await findByRole("switch", { name: /显示工具组/ })) as HTMLButtonElement;
		expect(sw.getAttribute("aria-checked")).toBe("true");

		fireEvent.click(sw);
		expect(sw.getAttribute("aria-checked")).toBe("false");
		// 持久化
		expect(mocks.setGeneralSettings).toHaveBeenCalledWith({ showToolExecution: false });
		// 全局 atom 实时更新（MessageBlockList 依赖它过滤）
		expect(appStore.get(showToolExecutionAtom)).toBe(false);
	});

	it("启动时从持久化设置回填 atom 读取状态", async () => {
		mocks.getGeneralSettings.mockResolvedValueOnce({
			success: true,
			settings: { language: "zh", showToolExecution: false },
		});
		const { findByRole } = renderTab();
		const sw = (await findByRole("switch", { name: /显示工具组/ })) as HTMLButtonElement;
		expect(sw.getAttribute("aria-checked")).toBe("false");
	});
});
