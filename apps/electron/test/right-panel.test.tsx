// @vitest-environment jsdom

import type { ProjectInfo } from "@shared/types";
import { act, render, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RightPanel } from "../src/renderer/components/workspace/RightPanel";
import i18n from "../src/renderer/i18n";
import { appStore } from "../src/renderer/store/ipcHandler";
import { activeProjectIdAtom, projectsAtom } from "../src/renderer/store/projectAtoms";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("sonner", () => ({
	toast: {
		error: toastError,
		info: vi.fn(),
		success: vi.fn(),
	},
}));

// 子面板与本测试无关,替换为轻量桩
vi.mock("../src/renderer/components/workspace/WorkspaceTreePanel", () => ({
	WorkspaceTreePanel: () => <div data-testid="workspace-tree" />,
}));
vi.mock("../src/renderer/components/workspace/SharedAreaPanel", () => ({
	SharedAreaPanel: () => <div data-testid="shared-area" />,
}));

const projects: ProjectInfo[] = [
	{ id: "project-1", name: "one", cwd: "/tmp/one", createdAt: 1, valid: true },
	{ id: "project-2", name: "two", cwd: "/tmp/two", createdAt: 2, valid: true },
];

function renderPanel() {
	return render(
		<Provider store={appStore}>
			<I18nextProvider i18n={i18n}>
				<RightPanel />
			</I18nextProvider>
		</Provider>,
	);
}

describe("RightPanel 共享区 watcher", () => {
	const listSharedFiles = vi.fn();
	const startSharedWatch = vi.fn();
	const stopSharedWatch = vi.fn();

	beforeEach(async () => {
		await i18n.changeLanguage("en");
		toastError.mockReset();
		listSharedFiles.mockReset().mockResolvedValue({ success: true, nodes: [] });
		startSharedWatch.mockReset().mockResolvedValue({ success: true });
		stopSharedWatch.mockReset().mockResolvedValue({ success: true });
		Object.defineProperty(window, "look", {
			configurable: true,
			value: { listSharedFiles, startSharedWatch, stopSharedWatch },
		});
		appStore.set(projectsAtom, projects);
		appStore.set(activeProjectIdAtom, "project-1");
	});

	afterEach(async () => {
		// 先重置 atom，再冲刷 effect 链上仍在途中的 promise
		// （listSharedFiles/startSharedWatch 的 .then 回调会触发 jotai 更新
		// 并排入 React 调度器）。若放任不管，它们会在 jsdom 拆除后才执行，
		// react-dom 访问 window 抛出 "window is not defined" 的
		// unhandled error（CI 上偶发退出码 1）。
		appStore.set(projectsAtom, []);
		appStore.set(activeProjectIdAtom, null);
		await act(async () => {});
		document.body.replaceChildren();
	});

	it("切换项目时启动新项目 watcher,但不停止旧 watcher(watcher 按项目常驻)", async () => {
		renderPanel();
		await waitFor(() => expect(startSharedWatch).toHaveBeenCalledWith("project-1"));

		act(() => appStore.set(activeProjectIdAtom, "project-2"));

		await waitFor(() => expect(startSharedWatch).toHaveBeenCalledWith("project-2"));
		expect(stopSharedWatch).not.toHaveBeenCalled();
	});

	it("组件卸载时也不调用 stopSharedWatch(项目删除时由主进程统一清理)", async () => {
		const { unmount } = renderPanel();
		await waitFor(() => expect(startSharedWatch).toHaveBeenCalledWith("project-1"));

		unmount();

		expect(stopSharedWatch).not.toHaveBeenCalled();
	});
});
