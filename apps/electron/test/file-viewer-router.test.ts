// ============================================================
// File viewer router tests — diffPatch 随窗口 open/ready/dock 全程传递
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvokeContext } from "../src/main/ipc/invoke-context.js";
import { fileViewerRouter } from "../src/main/ipc/routers/file-viewer-router.js";
import { makeDispatcher, makeMockContext } from "./helpers/ipc-test-helpers.js";

// 替换 viewer-window-manager：验证 openViewerWindow 收到 diffPatch、ready 取回 diffPatch
vi.mock("../src/main/viewer/viewer-window-manager.js", () => ({
	consumePendingPath: vi.fn(),
	fadeOutAndCloseViewer: vi.fn(),
	openViewerWindow: vi.fn(),
	resolveViewerDock: vi.fn(),
}));

import {
	consumePendingPath,
	fadeOutAndCloseViewer,
	openViewerWindow,
	resolveViewerDock,
} from "../src/main/viewer/viewer-window-manager.js";

function makeCtx(): InvokeContext {
	const ctx = makeMockContext();
	ctx.mainWindow = {
		show: vi.fn(),
		focus: vi.fn(),
		isDestroyed: () => false,
		webContents: {
			isDestroyed: () => false,
			send: vi.fn(),
		},
	} as never;
	return ctx;
}

describe("file-viewer-router diffPatch 链路", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("fileViewer:open 携带 diffPatch → openViewerWindow 收到（undock 保真）", async () => {
		const { dispatch } = makeDispatcher(fileViewerRouter, makeCtx());
		await dispatch({
			type: "fileViewer:open",
			path: "/repo/a.ts",
			fadeIn: true,
			diffPatch: "diff --git a/a.ts b/a.ts",
		});

		expect(openViewerWindow).toHaveBeenCalledWith("/repo/a.ts", {
			fadeIn: true,
			diffPatch: "diff --git a/a.ts b/a.ts",
		});
	});

	it("fileViewer:open 无 diffPatch → 不传 diffPatch 字段", async () => {
		const { dispatch } = makeDispatcher(fileViewerRouter, makeCtx());
		await dispatch({ type: "fileViewer:open", path: "/repo/b.ts" });

		expect(openViewerWindow).toHaveBeenCalledWith("/repo/b.ts", { fadeIn: false, diffPatch: undefined });
	});

	it("fileViewer:ready 返回暂存的 diffPatch", async () => {
		vi.mocked(consumePendingPath).mockReturnValue({
			path: "/repo/a.ts",
			diffPatch: "diff --git a/a.ts b/a.ts",
		});
		const { dispatch } = makeDispatcher(fileViewerRouter, makeCtx());

		const result = (await dispatch({ type: "fileViewer:ready" })) as {
			success: boolean;
			path: string;
			diffPatch: string;
		};

		expect(result).toEqual({ success: true, path: "/repo/a.ts", diffPatch: "diff --git a/a.ts b/a.ts" });
	});

	it("fileViewer:ready 无暂存请求 → path null 且无 diffPatch 字段", async () => {
		vi.mocked(consumePendingPath).mockReturnValue(null);
		const { dispatch } = makeDispatcher(fileViewerRouter, makeCtx());

		const result = (await dispatch({ type: "fileViewer:ready" })) as { success: boolean; path: null };

		expect(result).toEqual({ success: true, path: null });
		expect("diffPatch" in result).toBe(false);
	});

	it("fileViewer:dock 事件携带 diffPatch（merge 回主窗口恢复 diff 语义）", async () => {
		const ctx = makeCtx();
		const { dispatch } = makeDispatcher(fileViewerRouter, ctx);
		const send = vi.mocked(ctx.mainWindow.webContents.send as never) as ReturnType<typeof vi.fn>;

		await dispatch({ type: "fileViewer:dock", path: "/repo/a.ts", diffPatch: "diff --git a/a.ts b/a.ts" });

		expect(send).toHaveBeenCalledWith("look:event", {
			type: "fileViewer:docked",
			path: "/repo/a.ts",
			diffPatch: "diff --git a/a.ts b/a.ts",
		});
		// 两阶段握手：dock 只发合并事件，独立窗口等回执后才关闭
		expect(fadeOutAndCloseViewer).not.toHaveBeenCalled();
		expect(resolveViewerDock).not.toHaveBeenCalled();

		await dispatch({ type: "fileViewer:dock-result", confirmed: true });
		expect(resolveViewerDock).toHaveBeenCalledWith(true);
	});

	it("fileViewer:dock 无 diffPatch → 事件不带 diffPatch 字段", async () => {
		const ctx = makeCtx();
		const { dispatch } = makeDispatcher(fileViewerRouter, ctx);
		const send = vi.mocked(ctx.mainWindow.webContents.send as never) as ReturnType<typeof vi.fn>;

		await dispatch({ type: "fileViewer:dock", path: "/repo/b.ts" });

		expect(send).toHaveBeenCalledWith("look:event", { type: "fileViewer:docked", path: "/repo/b.ts" });
	});
});
