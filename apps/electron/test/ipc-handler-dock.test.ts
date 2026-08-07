// @vitest-environment jsdom
//
// fileViewer:docked（独立窗口“合并到主窗口”）IPC 路径的脏确认测试。
// 主窗口 Dock 面板内已有未保存修改时，合并事件不得静默覆盖（2026-08-07 修复）。

import type { MainToRendererEvent } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appStore } from "../src/renderer/store/appStore";
import { initIpcHandlers } from "../src/renderer/store/ipcHandler";
import { dockedFileAtom, fileViewerDirtyAtom } from "../src/renderer/store/projectAtoms";

let dispose: (() => void) | undefined;

beforeEach(() => {
	appStore.set(dockedFileAtom, null);
	appStore.set(fileViewerDirtyAtom, false);
});

afterEach(() => {
	dispose?.();
	dispose = undefined;
	appStore.set(dockedFileAtom, null);
	appStore.set(fileViewerDirtyAtom, false);
	vi.restoreAllMocks();
});

function makeReceiver(): (event: MainToRendererEvent) => void {
	let receive!: (event: MainToRendererEvent) => void;
	dispose = initIpcHandlers({
		onEvent(callback: (event: MainToRendererEvent) => void) {
			receive = callback;
			return () => {};
		},
	});
	return receive;
}

describe("fileViewer:docked IPC 脏确认", () => {
	it("dirty 且用户取消（confirm=false）：不替换 Dock 文件", () => {
		const receive = makeReceiver();
		appStore.set(dockedFileAtom, { absolutePath: "/tmp/a.md" });
		appStore.set(fileViewerDirtyAtom, true);
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

		receive({ type: "fileViewer:docked", path: "/tmp/b.md" });

		expect(appStore.get(dockedFileAtom)).toEqual({ absolutePath: "/tmp/a.md" });
		expect(confirmSpy).toHaveBeenCalledTimes(1);
	});

	it("dirty 且用户确认（confirm=true）：替换 Dock 文件", () => {
		const receive = makeReceiver();
		appStore.set(dockedFileAtom, { absolutePath: "/tmp/a.md" });
		appStore.set(fileViewerDirtyAtom, true);
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

		receive({ type: "fileViewer:docked", path: "/tmp/b.md" });

		expect(appStore.get(dockedFileAtom)).toEqual({ absolutePath: "/tmp/b.md" });
		expect(confirmSpy).toHaveBeenCalledTimes(1);
	});

	it("非 dirty：直接替换，不弹确认", () => {
		const receive = makeReceiver();
		appStore.set(dockedFileAtom, { absolutePath: "/tmp/a.md" });
		appStore.set(fileViewerDirtyAtom, false);
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

		receive({ type: "fileViewer:docked", path: "/tmp/b.md" });

		expect(appStore.get(dockedFileAtom)).toEqual({ absolutePath: "/tmp/b.md" });
		expect(confirmSpy).not.toHaveBeenCalled();
	});
});
