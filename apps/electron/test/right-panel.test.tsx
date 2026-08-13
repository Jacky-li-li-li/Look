// @vitest-environment jsdom

import { TooltipProvider } from "@look/ui/components/ui/tooltip";
import type { ProjectInfo } from "@shared/types";
import { act, render, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RightPanel } from "../src/renderer/components/workspace/RightPanel";
import i18n from "../src/renderer/i18n";
import { appStore } from "../src/renderer/store/appStore";
import {
	activeProjectIdAtom,
	projectGitInfoAtomFamily,
	projectsAtom,
	rightPanelAutoCollapsedAtom,
	rightPanelCollapsedAtom,
	rightPanelEffectiveCollapsedAtom,
} from "../src/renderer/store/projectAtoms";

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
				<TooltipProvider>
					<RightPanel />
				</TooltipProvider>
			</I18nextProvider>
		</Provider>,
	);
}

describe("RightPanel 共享区 watcher", () => {
	const listSharedFiles = vi.fn();
	const startSharedWatch = vi.fn();
	const stopSharedWatch = vi.fn();
	const getProjectGitInfo = vi.fn();

	beforeEach(async () => {
		await i18n.changeLanguage("en");
		toastError.mockReset();
		listSharedFiles.mockReset().mockResolvedValue({ success: true, nodes: [] });
		startSharedWatch.mockReset().mockResolvedValue({ success: true });
		stopSharedWatch.mockReset().mockResolvedValue({ success: true });
		getProjectGitInfo.mockReset().mockResolvedValue({ success: true, info: null });
		Object.defineProperty(window, "look", {
			configurable: true,
			value: { listSharedFiles, startSharedWatch, stopSharedWatch, getProjectGitInfo },
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
		appStore.set(rightPanelCollapsedAtom, false);
		appStore.set(rightPanelAutoCollapsedAtom, false);
		await act(async () => {});
		document.body.replaceChildren();
	});

	it("切换项目时停止旧项目 watcher,并启动新项目 watcher", async () => {
		renderPanel();
		await waitFor(() => expect(startSharedWatch).toHaveBeenCalledWith("project-1"));

		act(() => appStore.set(activeProjectIdAtom, "project-2"));

		await waitFor(() => expect(startSharedWatch).toHaveBeenCalledWith("project-2"));
		expect(stopSharedWatch).toHaveBeenCalledWith("project-1");
	});

	it("组件卸载时停止当前项目 watcher", async () => {
		const { unmount } = renderPanel();
		await waitFor(() => expect(startSharedWatch).toHaveBeenCalledWith("project-1"));

		unmount();

		expect(stopSharedWatch).toHaveBeenCalledWith("project-1");
	});

	it("切换项目时拉取 git info 填充「变更」tab 徽标数据（不依赖 GitStatusBar 挂载）", async () => {
		renderPanel();

		await waitFor(() => expect(getProjectGitInfo).toHaveBeenCalledWith("project-1"));
		expect(appStore.get(projectGitInfoAtomFamily("project-1"))).toBeNull();
	});

	it("git info 拉取失败不写入 atom（保持 null 徽标）", async () => {
		getProjectGitInfo.mockRejectedValue(new Error("boom"));
		renderPanel();

		await waitFor(() => expect(getProjectGitInfo).toHaveBeenCalledWith("project-1"));
		expect(appStore.get(projectGitInfoAtomFamily("project-1"))).toBeNull();
	});

	it("rightPanelEffectiveCollapsedAtom = 手动折叠 OR 自动折叠（2026-08 回归:resize 只操作 auto 态）", () => {
		expect(appStore.get(rightPanelEffectiveCollapsedAtom)).toBe(false);

		// 窄窗口自动折叠:effective 折叠,但手动偏好保持不变
		appStore.set(rightPanelAutoCollapsedAtom, true);
		expect(appStore.get(rightPanelEffectiveCollapsedAtom)).toBe(true);
		expect(appStore.get(rightPanelCollapsedAtom)).toBe(false);

		// 清除自动态:effective 跟随手动偏好恢复
		appStore.set(rightPanelAutoCollapsedAtom, false);
		expect(appStore.get(rightPanelEffectiveCollapsedAtom)).toBe(false);

		// 手动折叠同样生效
		appStore.set(rightPanelCollapsedAtom, true);
		expect(appStore.get(rightPanelEffectiveCollapsedAtom)).toBe(true);
	});
});
