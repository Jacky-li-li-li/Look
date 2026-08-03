// @vitest-environment jsdom

// ============================================================
// AboutTab tests — 设置页 About 更新控件（与 TopUpdateButton 逻辑
// 平行但独立：installing loading 态、错误文本、下载进度条）
// ============================================================

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Provider } from "jotai";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// useAppUpdate 在模块顶层绑定 window.look，必须在组件模块加载前就位
const mocks = vi.hoisted(() => {
	const installUpdate = vi.fn().mockResolvedValue({ success: true });
	const checkForUpdates = vi.fn().mockResolvedValue({ success: true });
	(window as unknown as { look: unknown }).look = { installUpdate, checkForUpdates };
	return { installUpdate, checkForUpdates };
});

import AboutTab from "../src/renderer/components/settings/AboutTab";
import i18n from "../src/renderer/i18n";
import { appStore } from "../src/renderer/store/appStore";
import { appUpdateAtom } from "../src/renderer/store/atoms";

function renderTab() {
	return render(
		<Provider store={appStore}>
			<I18nextProvider i18n={i18n}>
				<AboutTab />
			</I18nextProvider>
		</Provider>,
	);
}

describe("AboutTab update controls", () => {
	afterEach(() => cleanup());

	beforeEach(async () => {
		await i18n.changeLanguage("zh");
		act(() => appStore.set(appUpdateAtom, null));
	});

	it("downloaded 时显示重启安装按钮，点击后进入安装中 loading 态", () => {
		mocks.installUpdate.mockClear();
		act(() => appStore.set(appUpdateAtom, { phase: "downloaded", version: "9.9.9" }));

		const { getByRole } = renderTab();
		const button = getByRole("button", { name: "重启安装" }) as HTMLButtonElement;
		expect(button.disabled).toBe(false);

		fireEvent.click(button);
		expect(mocks.installUpdate).toHaveBeenCalledTimes(1);
		const installingButton = getByRole("button", { name: "正在重启安装…" }) as HTMLButtonElement;
		expect(installingButton.disabled).toBe(true);
	});

	it("error 时显示错误文本（destructive 反馈）", () => {
		act(() => appStore.set(appUpdateAtom, { phase: "error", error: "下载失败: 网络错误" }));

		const { getByText } = renderTab();
		expect(getByText("下载失败: 网络错误")).toBeTruthy();
	});

	it("downloading 时显示下载进度条百分比", () => {
		act(() => appStore.set(appUpdateAtom, { phase: "downloading", version: "9.9.9", percent: 42 }));

		const { getByText } = renderTab();
		expect(getByText("42%")).toBeTruthy();
	});

	it("not-available 时显示已是最新版本", () => {
		act(() => appStore.set(appUpdateAtom, { phase: "not-available" }));

		const { getByText } = renderTab();
		expect(getByText("已是最新版本")).toBeTruthy();
	});
});
