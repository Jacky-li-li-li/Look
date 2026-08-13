// @vitest-environment jsdom

import { TooltipProvider } from "@look/ui/components/ui/tooltip";
import type { FileTreeNode } from "@shared/types";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTreePanel } from "../src/renderer/components/workspace/WorkspaceTreePanel";
import i18n from "../src/renderer/i18n";
import { appStore } from "../src/renderer/store/appStore";
import {
	expandedWorkspacePathsAtomFamily,
	loadedWorkspaceChildrenAtomFamily,
	workspaceTreeErrorAtomFamily,
	workspaceTreeLoadingAtomFamily,
} from "../src/renderer/store/atoms";

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock("react-virtuoso", () => ({
	Virtuoso: ({
		data,
		itemContent,
	}: {
		data: unknown[];
		itemContent: (index: number, item: unknown) => React.ReactNode;
	}) => (
		<div>
			{data.map((item, index) => (
				<div key={index}>{itemContent(index, item)}</div>
			))}
		</div>
	),
}));

const PROJECT = "project-1";

const dirNode: FileTreeNode = {
	name: "reports",
	path: "reports",
	absolutePath: "/tmp/one/reports",
	type: "directory",
	children: [],
};

const fileNode: FileTreeNode = {
	name: "summary.md",
	path: "reports/summary.md",
	absolutePath: "/tmp/one/reports/summary.md",
	type: "file",
};

function renderPanel() {
	return render(
		<Provider store={appStore}>
			<I18nextProvider i18n={i18n}>
				<TooltipProvider>
					<WorkspaceTreePanel projectId={PROJECT} cwd="/tmp/one" />
				</TooltipProvider>
			</I18nextProvider>
		</Provider>,
	);
}

describe("WorkspaceTreePanel watcher 生命周期", () => {
	const listWorkspaceChildren = vi.fn();
	const startWorkspaceWatch = vi.fn();
	const stopWorkspaceWatch = vi.fn();

	beforeEach(async () => {
		await i18n.changeLanguage("en");
		appStore.set(expandedWorkspacePathsAtomFamily(PROJECT), new Set());
		appStore.set(loadedWorkspaceChildrenAtomFamily(PROJECT), new Map());
		appStore.set(workspaceTreeLoadingAtomFamily(PROJECT), false);
		appStore.set(workspaceTreeErrorAtomFamily(PROJECT), null);
		listWorkspaceChildren.mockReset();
		startWorkspaceWatch.mockReset().mockResolvedValue({ success: true });
		stopWorkspaceWatch.mockReset().mockResolvedValue({ success: true });
		listWorkspaceChildren.mockImplementation((_pid: string, rel: string) =>
			Promise.resolve({ success: true, nodes: rel === "" ? [dirNode] : [fileNode] }),
		);
		Object.defineProperty(window, "look", {
			configurable: true,
			value: { listWorkspaceChildren, startWorkspaceWatch, stopWorkspaceWatch },
		});
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	it("折叠后从缓存再次展开会重启该目录的 watcher（2026-08 回归）", async () => {
		renderPanel();
		await waitFor(() => expect(startWorkspaceWatch).toHaveBeenCalledWith(PROJECT, ""));

		// 首次展开:加载子项并启动 watcher
		fireEvent.click(screen.getByRole("button", { name: "展开" }));
		await waitFor(() => expect(screen.getByText("summary.md")).toBeTruthy());
		await waitFor(() => expect(startWorkspaceWatch).toHaveBeenCalledWith(PROJECT, "reports"));

		// 折叠:watcher 停止
		fireEvent.click(screen.getByRole("button", { name: "折叠" }));
		expect(stopWorkspaceWatch).toHaveBeenCalledWith(PROJECT, "reports");

		// 缓存命中再展开:必须重启 watcher,否则目录变更不再实时刷新
		fireEvent.click(screen.getByRole("button", { name: "展开" }));
		await waitFor(() => expect(startWorkspaceWatch).toHaveBeenCalledTimes(3));
		expect(startWorkspaceWatch.mock.calls.filter((call) => call[1] === "reports")).toHaveLength(2);
		expect(listWorkspaceChildren.mock.calls.filter((call) => call[1] === "reports")).toHaveLength(1);
	});

	it("startWorkspaceWatch 在途时折叠:撤销已登记 watcher,不让其常驻", async () => {
		let resolveStart!: (value: { success: boolean }) => void;
		startWorkspaceWatch
			.mockResolvedValueOnce({ success: true }) // 根 watcher
			.mockImplementationOnce(
				() =>
					new Promise<{ success: boolean }>((resolve) => {
						resolveStart = resolve;
					}),
			);
		renderPanel();
		await waitFor(() => expect(startWorkspaceWatch).toHaveBeenCalledWith(PROJECT, ""));

		// 展开:加载成功后在途启动 watcher(未 resolve)
		fireEvent.click(screen.getByRole("button", { name: "展开" }));
		await waitFor(() => expect(startWorkspaceWatch).toHaveBeenCalledWith(PROJECT, "reports"));

		// 在途时折叠:折叠分支立即 stop;resolve 后守卫发现已折叠,再次 stop 兜底
		fireEvent.click(screen.getByRole("button", { name: "折叠" }));
		expect(stopWorkspaceWatch).toHaveBeenCalledWith(PROJECT, "reports");

		resolveStart({ success: true });
		await waitFor(() =>
			expect(stopWorkspaceWatch.mock.calls.filter((call) => call[1] === "reports")).toHaveLength(2),
		);
	});

	it("startWorkspaceWatch 在途时卸载:清理逻辑停掉 pending watcher,不泄漏", async () => {
		let resolveStart!: (value: { success: boolean }) => void;
		startWorkspaceWatch.mockImplementation(
			() =>
				new Promise<{ success: boolean }>((resolve) => {
					resolveStart = resolve;
				}),
		);
		const { unmount } = renderPanel();
		await waitFor(() => expect(listWorkspaceChildren).toHaveBeenCalledWith(PROJECT, "", true));
		await waitFor(() => expect(startWorkspaceWatch).toHaveBeenCalledWith(PROJECT, ""));

		unmount();

		// 根 pending 在卸载清理时被 stop
		expect(stopWorkspaceWatch).toHaveBeenCalledWith(PROJECT, "");
		resolveStart({ success: true });
		await act(async () => {});
	});

	it("加载失败不进入展开态,也不会启动该目录 watcher", async () => {
		listWorkspaceChildren.mockImplementation((_pid: string, rel: string) =>
			Promise.resolve({ success: rel === "", nodes: [dirNode] }),
		);
		renderPanel();
		await waitFor(() => expect(startWorkspaceWatch).toHaveBeenCalledWith(PROJECT, ""));

		fireEvent.click(screen.getByRole("button", { name: "展开" }));
		await waitFor(() => expect(listWorkspaceChildren).toHaveBeenCalledWith(PROJECT, "reports", true));

		expect(startWorkspaceWatch.mock.calls.filter((call) => call[1] === "reports")).toHaveLength(0);
		expect(screen.queryByText("summary.md")).toBeNull();
	});
});
