// @vitest-environment jsdom

// ============================================================
// SidebarUpdateButton tests — 侧栏一键更新入口的可见性与交互
// ============================================================

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Provider } from "jotai";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// useAppUpdate 在模块顶层绑定 window.look，必须在组件模块加载前就位
const mocks = vi.hoisted(() => {
	const downloadUpdate = vi.fn().mockResolvedValue({ success: true });
	(window as unknown as { look: unknown }).look = { downloadUpdate };
	return { downloadUpdate };
});

import SidebarUpdateButton from "../src/renderer/components/Sidebar/SidebarUpdateButton";
import i18n from "../src/renderer/i18n";
import { appUpdateAtom } from "../src/renderer/store/atoms";
import { appStore } from "../src/renderer/store/ipcHandler";

function renderButton() {
	return render(
		<Provider store={appStore}>
			<I18nextProvider i18n={i18n}>
				<SidebarUpdateButton />
			</I18nextProvider>
		</Provider>,
	);
}

describe("SidebarUpdateButton", () => {
	afterEach(() => cleanup());

	beforeEach(async () => {
		await i18n.changeLanguage("zh");
		act(() => appStore.set(appUpdateAtom, null));
	});

	it("无更新状态时不渲染", () => {
		const { container } = renderButton();
		expect(container.firstChild).toBeNull();
	});

	it("available 时显示更新按钮，点击触发下载", () => {
		mocks.downloadUpdate.mockClear();
		act(() => appStore.set(appUpdateAtom, { phase: "available", version: "9.9.9" }));

		const { getByRole } = renderButton();
		const button = getByRole("button", { name: "更新" }) as HTMLButtonElement;
		expect(button.disabled).toBe(false);

		fireEvent.click(button);
		expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1);
	});

	it("downloading 时显示百分比且不可点击", () => {
		act(() => appStore.set(appUpdateAtom, { phase: "downloading", percent: 42 }));

		const { getByRole } = renderButton();
		const button = getByRole("button", { name: "42%" }) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
	});
});
