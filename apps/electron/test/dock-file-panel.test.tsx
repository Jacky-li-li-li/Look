// @vitest-environment jsdom
//
// DockFilePanel — undock（弹出为独立窗口）时 diffPatch 必须随窗口传递，
// 保证独立窗口渲染与 Dock 一致的完整文件 diff（S1-1 链路回归）。

import { cleanup, render } from "@testing-library/react";
import { Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileViewerDialog from "../src/renderer/components/dialogs/FileViewerDialog";
import { DockFilePanel } from "../src/renderer/components/workspace/DockFilePanel";
import i18n from "../src/renderer/i18n";
import { appStore } from "../src/renderer/store/appStore";
import { dockedFileAtom } from "../src/renderer/store/atoms";

// 用真实 FileViewerDialog 会触发 readFileContent 等大量副作用；这里替换为
// 捕获 props 的桩组件，聚焦 DockFilePanel 的 undock 回调行为。
vi.mock("../src/renderer/components/dialogs/FileViewerDialog", () => ({
	default: vi.fn((props: unknown) => <div data-testid="file-viewer-dialog" data-props={JSON.stringify(props)} />),
}));

const mockFileViewerDialog = vi.mocked(FileViewerDialog);
const openFileViewer = vi.fn();

beforeEach(async () => {
	await i18n.changeLanguage("zh");
	openFileViewer.mockReset();
	mockFileViewerDialog.mockClear();
	Object.defineProperty(window, "look", {
		configurable: true,
		value: { openFileViewer, homedir: "/Users/test" },
	});
	appStore.set(dockedFileAtom, null);
});

afterEach(() => {
	appStore.set(dockedFileAtom, null);
	cleanup();
});

function dockedProps(): { dockPath: string | null; dockDiffPatch?: string; onDockUndock?: () => void } {
	const [call] = mockFileViewerDialog.mock.calls;
	return (call?.[0] ?? {}) as { dockPath: string | null; dockDiffPatch?: string; onDockUndock?: () => void };
}

describe("DockFilePanel undock diffPatch 传递", () => {
	it("带 diffPatch 的文件弹出独立窗口时 diffPatch 随 openFileViewer 传递", () => {
		appStore.set(dockedFileAtom, {
			absolutePath: "/repo/a.ts",
			diffPatch: "diff --git a/a.ts b/a.ts",
		});

		render(
			<Provider store={appStore}>
				<DockFilePanel />
			</Provider>,
		);
		expect(dockedProps().dockPath).toBe("/repo/a.ts");
		expect(dockedProps().dockDiffPatch).toBe("diff --git a/a.ts b/a.ts");

		dockedProps().onDockUndock?.();

		expect(openFileViewer).toHaveBeenCalledWith("/repo/a.ts", true, "diff --git a/a.ts b/a.ts");
		expect(appStore.get(dockedFileAtom)).toBeNull();
	});

	it("无 diffPatch 的文件弹出时不传 diffPatch 参数", () => {
		appStore.set(dockedFileAtom, { absolutePath: "/repo/b.ts" });

		render(
			<Provider store={appStore}>
				<DockFilePanel />
			</Provider>,
		);

		dockedProps().onDockUndock?.();

		expect(openFileViewer).toHaveBeenCalledWith("/repo/b.ts", true, undefined);
		expect(appStore.get(dockedFileAtom)).toBeNull();
	});

	it("Dock 为空时不渲染查看器", () => {
		render(
			<Provider store={appStore}>
				<DockFilePanel />
			</Provider>,
		);
		expect(mockFileViewerDialog).not.toHaveBeenCalled();
	});
});
