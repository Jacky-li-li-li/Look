// @vitest-environment jsdom
//
// FileViewerDialog diff 渲染路径测试（S1-2 / S2-1 / S3-5 回归）：
//  - dockMode（带 diffPatch）→ 按入口语义渲染 patch（工具重放 / git diff），不调 HEAD IPC
//  - windowMode（仅 absolutePath）→ getGitFileHead 自动检测 + FileDiff 完整文件
//  - untracked（content=""）→ 带 patch 时仍渲染 patch（不再退化为“空 vs 当前”全新增）
//  - diff 生效时编辑按钮仍可用
//
// @pierre/diffs 的 FileDiff 是复杂虚拟化组件，jsdom 无法真实渲染，
// 这里替换为可断言的桩组件，验证 props 数据流而非渲染细节。

import { TooltipProvider } from "@look/ui/components/ui/tooltip";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileViewerDialog from "../src/renderer/components/dialogs/FileViewerDialog";
import i18n from "../src/renderer/i18n";
import { appStore } from "../src/renderer/store/appStore";
import { activeProjectIdAtom, projectsAtom, viewingFileAtom } from "../src/renderer/store/atoms";

const mdContent = "# 标题\n\n正文第一行\n\n正文第二行\n";

vi.mock("@pierre/diffs/dist/components/web-components.js", () => ({}));
vi.mock("@pierre/diffs/react", () => ({
	FileDiff: ({ fileDiff }: { fileDiff: { oldFile: { contents: string }; newFile: { contents: string } } }) => (
		<div data-testid="file-diff" data-old={fileDiff.oldFile.contents} data-new={fileDiff.newFile.contents} />
	),
	PatchDiff: ({ patch }: { patch: string }) => <div data-testid="patch-diff" data-patch={patch} />,
}));
vi.mock("@pierre/diffs", () => ({
	parseDiffFromFile: (oldFile: unknown, newFile: unknown) => ({ oldFile, newFile }),
}));

const readFileContent = vi.fn();
const getGitFileHead = vi.fn();
const getProjectGitFileHead = vi.fn();

beforeEach(async () => {
	await i18n.changeLanguage("zh");
	readFileContent.mockReset().mockResolvedValue({
		success: true,
		kind: "text",
		content: mdContent,
		truncated: false,
		sizeBytes: mdContent.length,
		inProject: true,
	});
	getGitFileHead.mockReset();
	getProjectGitFileHead.mockReset();
	Object.defineProperty(window, "look", {
		configurable: true,
		value: {
			readFileContent,
			getGitFileHead,
			getProjectGitFileHead,
			homedir: "/Users/test",
			revealInFinder: vi.fn(),
			writeFileContent: vi.fn(),
			dockFileViewer: vi.fn(),
			openFileViewer: vi.fn(),
		},
	});
	appStore.set(viewingFileAtom, null);
	appStore.set(projectsAtom, [{ id: "proj-1", name: "repo", cwd: "/repo", createdAt: 0, valid: true }]);
	appStore.set(activeProjectIdAtom, "proj-1");
});

afterEach(() => {
	appStore.set(viewingFileAtom, null);
	appStore.set(projectsAtom, []);
	appStore.set(activeProjectIdAtom, null);
	cleanup();
});

describe("FileViewerDialog diff 渲染路径", () => {
	it("dockMode 带 diffPatch：按入口语义渲染 patch，不调 HEAD IPC", async () => {
		getProjectGitFileHead.mockResolvedValue({ success: true, content: "old line\n# 标题\n" });
		render(
			<Provider store={appStore}>
				<TooltipProvider>
					<FileViewerDialog dockMode dockPath="/repo/note.md" dockDiffPatch="diff --git a/note.md b/note.md" />
				</TooltipProvider>
			</Provider>,
		);

		const patch = await screen.findByTestId("patch-diff");
		expect(patch.getAttribute("data-patch")).toBe("diff --git a/note.md b/note.md");
		expect(getProjectGitFileHead).not.toHaveBeenCalled();
		expect(getGitFileHead).not.toHaveBeenCalled();
		expect(screen.queryByTestId("file-diff")).toBeNull();
	});

	it("项目外绝对路径带 patch：同样按入口语义渲染 patch，不调 HEAD IPC", async () => {
		getGitFileHead.mockResolvedValue({ success: true, content: "old external\n" });
		render(
			<Provider store={appStore}>
				<TooltipProvider>
					<FileViewerDialog dockMode dockPath="/tmp/note.md" dockDiffPatch="diff --git a/note.md b/note.md" />
				</TooltipProvider>
			</Provider>,
		);

		expect(await screen.findByTestId("patch-diff")).toBeDefined();
		expect(getProjectGitFileHead).not.toHaveBeenCalled();
		expect(getGitFileHead).not.toHaveBeenCalled();
	});

	it("windowMode 无 diffPatch：走 getGitFileHead 自动检测", async () => {
		getGitFileHead.mockResolvedValue({ success: true, content: "old window\n" });
		appStore.set(viewingFileAtom, { absolutePath: "/repo/note.md" });
		render(
			<Provider store={appStore}>
				<TooltipProvider>
					<FileViewerDialog windowMode />
				</TooltipProvider>
			</Provider>,
		);

		await waitFor(() => expect(getGitFileHead).toHaveBeenCalledWith("/repo/note.md"));
		const diff = await screen.findByTestId("file-diff");
		expect(diff.getAttribute("data-old")).toBe("old window\n");
		expect(getProjectGitFileHead).not.toHaveBeenCalled();
	});

	it('untracked（HEAD 无此文件，content=""）：带 patch 仍渲染 patch（不再退化为全新增）', async () => {
		getProjectGitFileHead.mockResolvedValue({ success: true, content: "" });
		render(
			<Provider store={appStore}>
				<TooltipProvider>
					<FileViewerDialog dockMode dockPath="/repo/new.md" dockDiffPatch="--- /dev/null" />
				</TooltipProvider>
			</Provider>,
		);

		const patch = await screen.findByTestId("patch-diff");
		expect(patch.getAttribute("data-patch")).toBe("--- /dev/null");
		expect(screen.queryByTestId("file-diff")).toBeNull();
	});

	it("diff 生效时点「编辑」进入 textarea（不被 patch 分支遮蔽）", async () => {
		getProjectGitFileHead.mockResolvedValue({ success: true, content: "old\n" });
		render(
			<Provider store={appStore}>
				<TooltipProvider>
					<FileViewerDialog dockMode dockPath="/repo/note.md" dockDiffPatch="diff --git a/note.md b/note.md" />
				</TooltipProvider>
			</Provider>,
		);

		await screen.findByTestId("patch-diff");
		const editButton = screen.getByRole("button", { name: "编辑" });
		fireEvent.click(editButton);

		const textarea = document.querySelector("textarea");
		expect(textarea).not.toBeNull();
		expect(textarea?.textContent).toBe(mdContent);
		// 退出编辑回到 diff
		fireEvent.click(screen.getByRole("button", { name: "预览" }));
		expect(await screen.findByTestId("patch-diff")).toBeDefined();
	});

	it("带 diffPatch 且 HEAD 不可得：仍渲染 patch（入口语义不依赖 HEAD）", async () => {
		getProjectGitFileHead.mockResolvedValue({ success: true, content: null });
		render(
			<Provider store={appStore}>
				<TooltipProvider>
					<FileViewerDialog dockMode dockPath="/repo/note.md" dockDiffPatch="diff --git a/note.md b/note.md" />
				</TooltipProvider>
			</Provider>,
		);

		const patch = await screen.findByTestId("patch-diff");
		expect(patch.getAttribute("data-patch")).toBe("diff --git a/note.md b/note.md");
		expect(screen.queryByTestId("file-diff")).toBeNull();
	});

	it("删除文件 + diffPatch（右侧 git deleted）：渲染全删除 patch 而非加载失败", async () => {
		readFileContent.mockResolvedValue({
			success: false,
			error: "ENOENT: no such file or directory",
		});
		render(
			<Provider store={appStore}>
				<TooltipProvider>
					<FileViewerDialog
						dockMode
						dockPath="/repo/deleted.md"
						dockDiffPatch="diff --git a/deleted.md b/deleted.md"
					/>
				</TooltipProvider>
			</Provider>,
		);

		const patch = await screen.findByTestId("patch-diff");
		expect(patch.getAttribute("data-patch")).toBe("diff --git a/deleted.md b/deleted.md");
		expect(screen.queryByText(/文件不存在/)).toBeNull();
	});

	it("无 diffPatch 且 HEAD 为 null（非 git/无变更）：普通视图且不显示降级提示", async () => {
		getProjectGitFileHead.mockResolvedValue({ success: true, content: null });
		getGitFileHead.mockResolvedValue({ success: true, content: null });
		appStore.set(viewingFileAtom, { absolutePath: "/repo/note.md" });
		render(
			<Provider store={appStore}>
				<TooltipProvider>
					<FileViewerDialog windowMode />
				</TooltipProvider>
			</Provider>,
		);

		await waitFor(() => expect(screen.queryByTestId("file-diff")).toBeNull());
		expect(screen.queryByText(/无法加载 HEAD 版本/)).toBeNull();
	});
});
