// @vitest-environment jsdom

// ============================================================
// TopUpdateButton tests — 顶部更新胶囊的可见性与交互
// （自动下载 + 手动重启：available/downloading 展示下载进度光效，
//  downloaded 变为重启按钮，点击触发 installUpdate）
// ============================================================

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Provider } from "jotai";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// useAppUpdate 在模块顶层绑定 window.look，必须在组件模块加载前就位
const mocks = vi.hoisted(() => {
	const installUpdate = vi.fn().mockResolvedValue({ success: true });
	(window as unknown as { look: unknown }).look = { installUpdate };
	return { installUpdate };
});

import TopUpdateButton from "../src/renderer/components/Sidebar/TopUpdateButton";
import i18n from "../src/renderer/i18n";
import { appUpdateAtom } from "../src/renderer/store/atoms";
import { appStore } from "../src/renderer/store/ipcHandler";

function renderButton() {
	return render(
		<Provider store={appStore}>
			<I18nextProvider i18n={i18n}>
				<TopUpdateButton />
			</I18nextProvider>
		</Provider>,
	);
}

describe("TopUpdateButton", () => {
	afterEach(() => cleanup());

	beforeEach(async () => {
		await i18n.changeLanguage("zh");
		act(() => appStore.set(appUpdateAtom, null));
	});

	it("无更新状态时不渲染", () => {
		const { container } = renderButton();
		expect(container.firstChild).toBeNull();
	});

	it("available 时显示「更新中」胶囊且不可点击（自动下载已开始）", () => {
		act(() => appStore.set(appUpdateAtom, { phase: "available", version: "9.9.9" }));

		const { getByRole } = renderButton();
		const button = getByRole("button", { name: "正在下载更新" }) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(button.textContent).toContain("更新中");
	});

	it("downloading 时仅显示「更新中」（百分比由边框光效展示）且不可点击", () => {
		act(() => appStore.set(appUpdateAtom, { phase: "downloading", percent: 42 }));

		const { getByRole } = renderButton();
		const button = getByRole("button", { name: "正在下载更新" }) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(button.textContent).toContain("更新中");
		expect(button.textContent).not.toContain("%");
	});

	it("downloaded 时变为重启按钮，点击触发手动重启安装", () => {
		mocks.installUpdate.mockClear();
		act(() => appStore.set(appUpdateAtom, { phase: "downloaded", version: "9.9.9" }));

		const { getByRole } = renderButton();
		const button = getByRole("button", { name: "重启更新" }) as HTMLButtonElement;
		expect(button.disabled).toBe(false);

		fireEvent.click(button);
		expect(mocks.installUpdate).toHaveBeenCalledTimes(1);
	});
});
