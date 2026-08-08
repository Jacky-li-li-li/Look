// @vitest-environment jsdom

import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	confirmDockFileSwapIfDirty,
	dockedFileAtom,
	fileViewerDirtyAtom,
	requestViewFileAtom,
} from "../src/renderer/store/projectAtoms";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("sonner", () => ({
	toast: { error: toastError, info: vi.fn(), success: vi.fn() },
}));

describe("requestViewFileAtom", () => {
	const statFilePath = vi.fn();
	const openFileViewer = vi.fn();
	const revealInFinder = vi.fn();

	beforeEach(() => {
		toastError.mockReset();
		statFilePath.mockReset();
		openFileViewer.mockReset();
		revealInFinder.mockReset();
		Object.defineProperty(window, "look", {
			configurable: true,
			value: { statFilePath, openFileViewer, revealInFinder },
		});
	});

	it("opens outside-project files read-only in the dock (no toast, no separate window)", async () => {
		// 2026-08-08 方案 B:项目外文件允许只读查看,stat 的 Path denied 不再拦截
		const store = createStore();
		statFilePath.mockResolvedValue({
			success: false,
			error: "Path denied for path: outside allowed project directories",
		});
		await store.set(requestViewFileAtom, "/Users/x/Desktop/a.png");
		expect(toastError).not.toHaveBeenCalled();
		expect(openFileViewer).not.toHaveBeenCalled();
		expect(revealInFinder).not.toHaveBeenCalled();
		expect(store.get(dockedFileAtom)).toEqual({ absolutePath: "/Users/x/Desktop/a.png" });
	});

	it("reveals directories in Finder instead of opening the viewer", async () => {
		statFilePath.mockResolvedValue({ success: true, kind: "directory" });
		await createStore().set(requestViewFileAtom, "/tmp/dir");
		expect(revealInFinder).toHaveBeenCalledWith("/tmp/dir");
		expect(openFileViewer).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("opens regular files in the main-window dock by default", async () => {
		const store = createStore();
		statFilePath.mockResolvedValue({ success: true, kind: "file" });
		await store.set(requestViewFileAtom, "/tmp/a.md");
		expect(store.get(dockedFileAtom)).toEqual({ absolutePath: "/tmp/a.md" });
		expect(openFileViewer).not.toHaveBeenCalled();
	});

	it("still opens missing files in the dock so the viewer shows its own error", async () => {
		const store = createStore();
		statFilePath.mockResolvedValue({ success: true, kind: "missing" });
		await store.set(requestViewFileAtom, "/tmp/none.md");
		expect(store.get(dockedFileAtom)).toEqual({ absolutePath: "/tmp/none.md" });
		expect(openFileViewer).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("still opens in the dock when stat fails for non-guard reasons", async () => {
		const store = createStore();
		statFilePath.mockRejectedValue(new Error("ipc broken"));
		await store.set(requestViewFileAtom, "/tmp/a.md");
		expect(store.get(dockedFileAtom)).toEqual({ absolutePath: "/tmp/a.md" });
		expect(openFileViewer).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	// ---- Dock 面板感知：Dock 打开时点击文件更新面板而非弹独立窗口 ----

	it("updates the dock panel instead of opening a separate window when docked", async () => {
		const store = createStore();
		store.set(dockedFileAtom, { absolutePath: "/tmp/docked.md" });
		statFilePath.mockResolvedValue({ success: true, kind: "file" });
		await store.set(requestViewFileAtom, "/tmp/a.md");
		expect(openFileViewer).not.toHaveBeenCalled();
		expect(store.get(dockedFileAtom)).toEqual({ absolutePath: "/tmp/a.md" });
	});

	it("still reveals directories in Finder while docked without changing the dock", async () => {
		const store = createStore();
		store.set(dockedFileAtom, { absolutePath: "/tmp/docked.md" });
		statFilePath.mockResolvedValue({ success: true, kind: "directory" });
		await store.set(requestViewFileAtom, "/tmp/dir");
		expect(revealInFinder).toHaveBeenCalledWith("/tmp/dir");
		expect(openFileViewer).not.toHaveBeenCalled();
		expect(store.get(dockedFileAtom)).toEqual({ absolutePath: "/tmp/docked.md" });
	});

	it("updates the dock to the outside-project file read-only (no toast)", async () => {
		const store = createStore();
		store.set(dockedFileAtom, { absolutePath: "/tmp/docked.md" });
		statFilePath.mockResolvedValue({
			success: false,
			error: "Path denied for path: outside allowed project directories",
		});
		await store.set(requestViewFileAtom, "/Users/x/Desktop/a.png");
		expect(toastError).not.toHaveBeenCalled();
		expect(openFileViewer).not.toHaveBeenCalled();
		expect(store.get(dockedFileAtom)).toEqual({ absolutePath: "/Users/x/Desktop/a.png" });
	});

	// ---- Dock 脏确认：外部跳转不得静默覆盖未保存修改（2026-08-07 修复） ----

	it("declines replacing the dock file when the dock has unsaved edits (confirm=false)", async () => {
		const store = createStore();
		store.set(dockedFileAtom, { absolutePath: "/tmp/docked.md" });
		store.set(fileViewerDirtyAtom, true);
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
		statFilePath.mockResolvedValue({ success: true, kind: "file" });
		await store.set(requestViewFileAtom, "/tmp/b.md");
		expect(openFileViewer).not.toHaveBeenCalled();
		expect(store.get(dockedFileAtom)).toEqual({ absolutePath: "/tmp/docked.md" });
		expect(confirmSpy).toHaveBeenCalledTimes(1);
	});

	it("replaces the dock file after confirming when the dock has unsaved edits (confirm=true)", async () => {
		const store = createStore();
		store.set(dockedFileAtom, { absolutePath: "/tmp/docked.md" });
		store.set(fileViewerDirtyAtom, true);
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
		statFilePath.mockResolvedValue({ success: true, kind: "file" });
		await store.set(requestViewFileAtom, "/tmp/b.md");
		expect(store.get(dockedFileAtom)).toEqual({ absolutePath: "/tmp/b.md" });
		expect(confirmSpy).toHaveBeenCalledTimes(1);
	});

	it("does not confirm when the dock has no unsaved edits", async () => {
		const store = createStore();
		store.set(dockedFileAtom, { absolutePath: "/tmp/docked.md" });
		store.set(fileViewerDirtyAtom, false);
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
		statFilePath.mockResolvedValue({ success: true, kind: "file" });
		await store.set(requestViewFileAtom, "/tmp/b.md");
		expect(store.get(dockedFileAtom)).toEqual({ absolutePath: "/tmp/b.md" });
		expect(confirmSpy).not.toHaveBeenCalled();
	});

	it("confirmDockFileSwapIfDirty skips the prompt when not dirty", () => {
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
		expect(confirmDockFileSwapIfDirty(() => false)).toBe(true);
		expect(confirmSpy).not.toHaveBeenCalled();
		expect(confirmDockFileSwapIfDirty(() => true)).toBe(false);
		expect(confirmSpy).toHaveBeenCalledTimes(1);
	});
});
