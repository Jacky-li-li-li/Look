// @vitest-environment jsdom

import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dockedFileAtom, requestViewFileAtom } from "../src/renderer/store/projectAtoms";

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

	it("toasts and does not open the viewer when the path guard denies access", async () => {
		statFilePath.mockResolvedValue({
			success: false,
			error: "Path denied for path: outside allowed project directories",
		});
		await createStore().set(requestViewFileAtom, "/Users/x/Desktop/a.png");
		expect(toastError).toHaveBeenCalledTimes(1);
		expect(openFileViewer).not.toHaveBeenCalled();
		expect(revealInFinder).not.toHaveBeenCalled();
	});

	it("reveals directories in Finder instead of opening the viewer", async () => {
		statFilePath.mockResolvedValue({ success: true, kind: "directory" });
		await createStore().set(requestViewFileAtom, "/tmp/dir");
		expect(revealInFinder).toHaveBeenCalledWith("/tmp/dir");
		expect(openFileViewer).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("opens regular files in the viewer", async () => {
		statFilePath.mockResolvedValue({ success: true, kind: "file" });
		await createStore().set(requestViewFileAtom, "/tmp/a.md");
		expect(openFileViewer).toHaveBeenCalledWith("/tmp/a.md");
	});

	it("still opens the viewer for missing files so the viewer shows its own error", async () => {
		statFilePath.mockResolvedValue({ success: true, kind: "missing" });
		await createStore().set(requestViewFileAtom, "/tmp/none.md");
		expect(openFileViewer).toHaveBeenCalledWith("/tmp/none.md");
		expect(toastError).not.toHaveBeenCalled();
	});

	it("keeps the original behavior when stat fails for non-guard reasons", async () => {
		statFilePath.mockRejectedValue(new Error("ipc broken"));
		await createStore().set(requestViewFileAtom, "/tmp/a.md");
		expect(openFileViewer).toHaveBeenCalledWith("/tmp/a.md");
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

	it("keeps the dock panel unchanged and toasts when the path guard denies access", async () => {
		const store = createStore();
		store.set(dockedFileAtom, { absolutePath: "/tmp/docked.md" });
		statFilePath.mockResolvedValue({
			success: false,
			error: "Path denied for path: outside allowed project directories",
		});
		await store.set(requestViewFileAtom, "/Users/x/Desktop/a.png");
		expect(toastError).toHaveBeenCalledTimes(1);
		expect(openFileViewer).not.toHaveBeenCalled();
		expect(store.get(dockedFileAtom)).toEqual({ absolutePath: "/tmp/docked.md" });
	});
});
