// @vitest-environment jsdom

import { TooltipProvider } from "@look/ui/components/ui/tooltip";
import { cleanup, render, screen } from "@testing-library/react";
import { Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileViewerDialog from "../src/renderer/components/dialogs/FileViewerDialog";
import i18n from "../src/renderer/i18n";
import { appStore } from "../src/renderer/store/appStore";
import { viewingFileAtom } from "../src/renderer/store/atoms";

const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

describe("FileViewerDialog 图片预览", () => {
	const readFileContent = vi.fn();

	beforeEach(async () => {
		await i18n.changeLanguage("zh");
		readFileContent.mockReset().mockResolvedValue({
			success: true,
			kind: "image",
			data: pngBase64,
			mimeType: "image/png",
			sizeBytes: 4,
		});
		Object.defineProperty(window, "look", {
			configurable: true,
			value: {
				readFileContent,
				homedir: "/Users/test",
				revealInFinder: vi.fn(),
				writeFileContent: vi.fn(),
				// 文件查看器统一自动检测 git 变更；这些测试场景无需 diff，返回 null
				getGitFileHead: vi.fn().mockResolvedValue({ success: true, content: null }),
				getProjectGitFileHead: vi.fn().mockResolvedValue({ success: true, content: null }),
			},
		});
		appStore.set(viewingFileAtom, { absolutePath: "/tmp/proj/shot.png" });
	});

	afterEach(() => {
		appStore.set(viewingFileAtom, null);
		cleanup();
	});

	it("renders image content inline instead of the binary fallback", async () => {
		render(
			<Provider store={appStore}>
				<TooltipProvider>
					<FileViewerDialog />
				</TooltipProvider>
			</Provider>,
		);
		const img = await screen.findByAltText("shot.png");
		expect(img.getAttribute("src")).toBe(`data:image/png;base64,${pngBase64}`);
		expect(screen.queryByText(/二进制文件无法预览/)).toBeNull();
	});

	it("shows the binary fallback for non-image binary files", async () => {
		readFileContent.mockResolvedValue({ success: true, kind: "binary", sizeBytes: 16 });
		render(
			<Provider store={appStore}>
				<TooltipProvider>
					<FileViewerDialog />
				</TooltipProvider>
			</Provider>,
		);
		await screen.findByText("二进制文件无法预览。");
		expect(screen.queryByAltText("shot.png")).toBeNull();
	});
});

describe("FileViewerDialog 返回按钮", () => {
	const readFileContent = vi.fn();

	beforeEach(async () => {
		await i18n.changeLanguage("zh");
		readFileContent.mockReset().mockResolvedValue({
			success: true,
			kind: "text",
			content: "# 标题\n\n正文",
			truncated: false,
			sizeBytes: 10,
		});
		Object.defineProperty(window, "look", {
			configurable: true,
			value: {
				readFileContent,
				homedir: "/Users/test",
				revealInFinder: vi.fn(),
				writeFileContent: vi.fn(),
				// 文件查看器统一自动检测 git 变更；这些测试场景无需 diff，返回 null
				getGitFileHead: vi.fn().mockResolvedValue({ success: true, content: null }),
				getProjectGitFileHead: vi.fn().mockResolvedValue({ success: true, content: null }),
			},
		});
		appStore.set(viewingFileAtom, { absolutePath: "/tmp/proj/readme.md" });
	});

	afterEach(() => {
		appStore.set(viewingFileAtom, null);
		cleanup();
	});

	it("首次打开（无导航历史）时不渲染返回按钮", async () => {
		render(
			<Provider store={appStore}>
				<TooltipProvider>
					<FileViewerDialog />
				</TooltipProvider>
			</Provider>,
		);
		await screen.findByText("readme.md");
		// 无历史:返回按钮不存在,而非 disabled 灰显
		expect(screen.queryByLabelText("返回")).toBeNull();
	});
});

describe("FileViewerDialog 项目外文件只读", () => {
	const readFileContent = vi.fn();

	beforeEach(async () => {
		await i18n.changeLanguage("zh");
		readFileContent.mockReset().mockResolvedValue({
			success: true,
			kind: "text",
			content: "# 标题\n\n正文",
			truncated: false,
			sizeBytes: 10,
			inProject: false,
		});
		Object.defineProperty(window, "look", {
			configurable: true,
			value: {
				readFileContent,
				homedir: "/Users/test",
				revealInFinder: vi.fn(),
				writeFileContent: vi.fn(),
				// 文件查看器统一自动检测 git 变更；这些测试场景无需 diff，返回 null
				getGitFileHead: vi.fn().mockResolvedValue({ success: true, content: null }),
				getProjectGitFileHead: vi.fn().mockResolvedValue({ success: true, content: null }),
			},
		});
		appStore.set(viewingFileAtom, { absolutePath: "/Users/test/Desktop/outside.md" });
	});

	afterEach(() => {
		appStore.set(viewingFileAtom, null);
		cleanup();
	});

	it("shows the read-only badge and hides edit/save for outside-project files", async () => {
		render(
			<Provider store={appStore}>
				<TooltipProvider>
					<FileViewerDialog />
				</TooltipProvider>
			</Provider>,
		);
		// 徽标出现在标题栏与底部状态条两处
		const badges = await screen.findAllByText("项目外 · 只读");
		expect(badges.length).toBeGreaterThanOrEqual(1);
		// 项目外文件禁止编辑/保存
		expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
		expect(screen.queryByLabelText("保存")).toBeNull();
	});

	it("hides the read-only badge for in-project files and keeps edit available", async () => {
		readFileContent.mockResolvedValue({
			success: true,
			kind: "text",
			content: "# 标题\n\n正文",
			truncated: false,
			sizeBytes: 10,
			inProject: true,
		});
		appStore.set(viewingFileAtom, { absolutePath: "/tmp/proj/inner.md" });
		render(
			<Provider store={appStore}>
				<TooltipProvider>
					<FileViewerDialog />
				</TooltipProvider>
			</Provider>,
		);
		await screen.findByText("inner.md");
		expect(screen.queryByText("项目外 · 只读")).toBeNull();
		expect(screen.getByRole("button", { name: "编辑" })).toBeDefined();
	});
});
