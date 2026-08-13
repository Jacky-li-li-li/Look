// @vitest-environment jsdom

import type { FileTreeNode } from "@shared/types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedAreaPanel } from "../src/renderer/components/workspace/SharedAreaPanel";
import i18n from "../src/renderer/i18n";
import { appStore } from "../src/renderer/store/appStore";
import {
	expandedSharedPathsAtomFamily,
	loadedSharedChildrenAtomFamily,
	selectedSharedPathAtomFamily,
} from "../src/renderer/store/atoms";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("sonner", () => ({
	toast: {
		error: toastError,
		info: vi.fn(),
		success: vi.fn(),
	},
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

const files: FileTreeNode[] = [
	{
		name: "notes.md",
		path: "notes.md",
		absolutePath: "/project/.look/shared/notes.md",
		type: "file",
	},
];

const reportsFolder: FileTreeNode = {
	name: "reports",
	path: "reports",
	absolutePath: "/project/.look/shared/reports",
	type: "directory",
	children: [],
};

const reportFile: FileTreeNode = {
	name: "summary.md",
	path: "reports/summary.md",
	absolutePath: "/project/.look/shared/reports/summary.md",
	type: "file",
};

const updatedReportFile: FileTreeNode = {
	name: "revised.md",
	path: "reports/revised.md",
	absolutePath: "/project/.look/shared/reports/revised.md",
	type: "file",
};

function renderPanel(overrides?: {
	projectId?: string;
	files?: FileTreeNode[];
	error?: string | null;
	onAfterChange?: () => Promise<void>;
}) {
	return render(
		<Provider store={appStore}>
			<I18nextProvider i18n={i18n}>
				<SharedAreaPanel
					projectId={overrides?.projectId ?? "project-1"}
					files={overrides?.files ?? files}
					isLoading={false}
					error={overrides?.error ?? null}
					onAfterChange={overrides?.onAfterChange ?? vi.fn().mockResolvedValue(undefined)}
				/>
			</I18nextProvider>
		</Provider>,
	);
}

function rerenderPanel(
	rerender: (ui: React.ReactElement) => void,
	overrides?: { projectId?: string; files?: FileTreeNode[]; error?: string | null },
) {
	rerender(
		<Provider store={appStore}>
			<I18nextProvider i18n={i18n}>
				<SharedAreaPanel
					projectId={overrides?.projectId ?? "project-1"}
					files={overrides?.files ?? files}
					isLoading={false}
					error={overrides?.error ?? null}
					onAfterChange={vi.fn().mockResolvedValue(undefined)}
				/>
			</I18nextProvider>
		</Provider>,
	);
}

describe("SharedAreaPanel", () => {
	const writeSharedFile = vi.fn();
	const openFileDialog = vi.fn();
	const importToShared = vi.fn();
	const listSharedChildren = vi.fn();

	beforeEach(async () => {
		await i18n.changeLanguage("en");
		appStore.set(expandedSharedPathsAtomFamily("project-1"), new Set());
		appStore.set(loadedSharedChildrenAtomFamily("project-1"), new Map());
		appStore.set(selectedSharedPathAtomFamily("project-1"), null);
		appStore.set(expandedSharedPathsAtomFamily("project-2"), new Set());
		appStore.set(loadedSharedChildrenAtomFamily("project-2"), new Map());
		appStore.set(selectedSharedPathAtomFamily("project-2"), null);
		toastError.mockReset();
		writeSharedFile.mockReset().mockResolvedValue({ success: true });
		openFileDialog.mockReset().mockResolvedValue({ success: true, paths: [] });
		importToShared.mockReset().mockResolvedValue({ success: true });
		listSharedChildren.mockReset().mockResolvedValue({ success: true, nodes: [] });
		Object.defineProperty(window, "look", {
			configurable: true,
			value: {
				listSharedChildren,
				writeSharedFile,
				createSharedDir: vi.fn().mockResolvedValue({ success: true }),
				deleteSharedItem: vi.fn().mockResolvedValue({ success: true }),
				openFileDialog,
				openDirectoryDialog: vi.fn().mockResolvedValue({ success: true }),
				importToShared,
				exportFromShared: vi.fn().mockResolvedValue({ success: true }),
				writeSharedContent: vi.fn().mockResolvedValue({ success: true }),
				getPathForFile: vi.fn().mockReturnValue(null),
				revealInFinder: vi.fn().mockResolvedValue({ success: true }),
			},
		});
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	it("keeps file selection and the row action menu as separate interactive controls", () => {
		const { container } = renderPanel();
		// 行本身是可点击的选中区域（文件名文本），操作菜单是独立的按钮，两者不得嵌套
		expect(screen.getByText("notes.md")).toBeTruthy();
		expect(screen.getByRole("button", { name: "More actions" })).toBeTruthy();
		expect(container.querySelector("button button")).toBeNull();
	});

	it("loads and renders a folder's immediate children when expanded", async () => {
		listSharedChildren.mockResolvedValue({ success: true, nodes: [reportFile] });
		renderPanel({ files: [reportsFolder] });

		fireEvent.click(screen.getByRole("button", { name: "Expand folder: reports" }));

		await waitFor(() => expect(listSharedChildren).toHaveBeenCalledWith("project-1", "reports"), { timeout: 3000 });
		await waitFor(() => expect(screen.getByText("summary.md")).toBeTruthy(), { timeout: 3000 });
		expect(screen.getByRole("treeitem", { name: "Folder: reports" }).getAttribute("aria-expanded")).toBe("true");
	});

	it("uses the cached children after a folder is collapsed and expanded again", async () => {
		listSharedChildren.mockResolvedValue({ success: true, nodes: [reportFile] });
		renderPanel({ files: [reportsFolder] });

		const toggle = screen.getByRole("button", { name: "Expand folder: reports" });
		fireEvent.click(toggle);
		await waitFor(() => expect(screen.getByText("summary.md")).toBeTruthy(), { timeout: 3000 });
		fireEvent.click(screen.getByRole("button", { name: "Collapse folder: reports" }));
		fireEvent.click(screen.getByRole("button", { name: "Expand folder: reports" }));

		expect(listSharedChildren).toHaveBeenCalledTimes(1);
		expect(screen.getByText("summary.md")).toBeTruthy();
	});

	it("refreshes cached child directories after the root list changes", async () => {
		listSharedChildren
			.mockResolvedValueOnce({ success: true, nodes: [reportFile] })
			.mockResolvedValueOnce({ success: true, nodes: [updatedReportFile] });
		const { rerender } = renderPanel({ files: [reportsFolder] });

		fireEvent.click(screen.getByRole("button", { name: "Expand folder: reports" }));
		await waitFor(() => expect(screen.getByText("summary.md")).toBeTruthy(), { timeout: 3000 });

		rerender(
			<Provider store={appStore}>
				<I18nextProvider i18n={i18n}>
					<SharedAreaPanel
						projectId="project-1"
						files={[{ ...reportsFolder }]}
						isLoading={false}
						onAfterChange={vi.fn().mockResolvedValue(undefined)}
					/>
				</I18nextProvider>
			</Provider>,
		);

		await waitFor(() => expect(screen.getByText("revised.md")).toBeTruthy(), { timeout: 3000 });
		expect(screen.queryByText("summary.md")).toBeNull();
		expect(listSharedChildren).toHaveBeenCalledTimes(2);
	});

	it("shows an error with retry instead of pretending the shared area is empty", async () => {
		renderPanel({ files: [], error: "Disk is read-only" });

		expect(screen.getByText("Disk is read-only")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
		expect(screen.queryByText(/Shared is empty/)).toBeNull();
	});

	it("keeps a single tab stop and moves focus with the arrow keys", () => {
		renderPanel({ files: [reportsFolder, reportFile] });

		const rows = screen.getAllByRole("treeitem");
		expect(rows[0].getAttribute("tabindex")).toBe("0");
		expect(rows[1].getAttribute("tabindex")).toBe("-1");

		fireEvent.keyDown(rows[0], { key: "ArrowDown" });
		expect(rows[0].getAttribute("tabindex")).toBe("-1");
		expect(rows[1].getAttribute("tabindex")).toBe("0");

		fireEvent.keyDown(rows[1], { key: "Home" });
		expect(rows[0].getAttribute("tabindex")).toBe("0");
		expect(rows[1].getAttribute("tabindex")).toBe("-1");
	});

	it("does not leak in-flight loading state when switching projects", async () => {
		let resolveProjectA!: (value: { success: boolean; nodes: FileTreeNode[] }) => void;
		listSharedChildren.mockReturnValueOnce(
			new Promise<{ success: boolean; nodes: FileTreeNode[] }>((resolve) => {
				resolveProjectA = resolve;
			}),
		);
		const { rerender } = renderPanel({ files: [reportsFolder] });

		fireEvent.click(screen.getByRole("button", { name: "Expand folder: reports" }));
		// 项目 A 请求仍在途；切到项目 B 同名目录后按钮必须可用且请求指向 B。
		rerenderPanel(rerender, { projectId: "project-2", files: [reportsFolder] });
		const button = screen.getByRole("button", { name: "Expand folder: reports" }) as HTMLButtonElement;
		expect(button.disabled).toBe(false);

		fireEvent.click(screen.getByRole("button", { name: "Expand folder: reports" }));
		expect(listSharedChildren).toHaveBeenLastCalledWith("project-2", "reports");

		resolveProjectA({ success: true, nodes: [] });
		await waitFor(() => expect(listSharedChildren).toHaveBeenCalledTimes(2), { timeout: 3000 });
	});

	it("keeps the expanded tree when a child refresh fails temporarily", async () => {
		listSharedChildren
			.mockResolvedValueOnce({ success: true, nodes: [reportFile] })
			.mockResolvedValueOnce({ success: false, error: "Disk busy" });
		const { rerender } = renderPanel({ files: [reportsFolder] });

		fireEvent.click(screen.getByRole("button", { name: "Expand folder: reports" }));
		await waitFor(() => expect(screen.getByText("summary.md")).toBeTruthy(), { timeout: 3000 });

		rerenderPanel(rerender, { files: [{ ...reportsFolder }] });
		await waitFor(() => expect(listSharedChildren).toHaveBeenCalledTimes(2), { timeout: 3000 });

		// 临时失败保留缓存与展开态，不静默折叠。
		expect(screen.getByText("summary.md")).toBeTruthy();
		expect(screen.getByRole("treeitem", { name: "Folder: reports" }).getAttribute("aria-expanded")).toBe("true");
	});

	it("collapses a folder whose directory disappeared after refresh", async () => {
		listSharedChildren
			.mockResolvedValueOnce({ success: true, nodes: [reportFile] })
			.mockResolvedValueOnce({ success: false, error: "gone", errorCode: "ENOENT" });
		const { rerender } = renderPanel({ files: [reportsFolder] });

		fireEvent.click(screen.getByRole("button", { name: "Expand folder: reports" }));
		await waitFor(() => expect(screen.getByText("summary.md")).toBeTruthy(), { timeout: 3000 });

		rerenderPanel(rerender, { files: [{ ...reportsFolder }] });
		await waitFor(() => expect(listSharedChildren).toHaveBeenCalledTimes(2), { timeout: 3000 });
		await waitFor(() =>
			expect(screen.getByRole("treeitem", { name: "Folder: reports" }).getAttribute("aria-expanded")).toBe("false"),
		);
		expect(screen.queryByText("summary.md")).toBeNull();
	});

	it("does not report a failed create result as success or close the creation input", async () => {
		const onAfterChange = vi.fn().mockResolvedValue(undefined);
		writeSharedFile.mockResolvedValue({ success: false, error: "Disk is read-only" });
		renderPanel({ files: [], onAfterChange });

		fireEvent.click(screen.getByRole("button", { name: "New file" }));
		const input = screen.getByPlaceholderText("File name");
		fireEvent.change(input, { target: { value: "draft.md" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(toastError).toHaveBeenCalledWith("Disk is read-only"), { timeout: 3000 });
		expect(onAfterChange).not.toHaveBeenCalled();
		expect(screen.getByPlaceholderText("File name")).toBeTruthy();
	});

	it("checks the import IPC result before refreshing or showing success", async () => {
		const onAfterChange = vi.fn().mockResolvedValue(undefined);
		openFileDialog.mockResolvedValue({ success: true, paths: ["/tmp/a.txt"] });
		importToShared.mockResolvedValue({ success: false, error: "Import denied" });
		renderPanel({ onAfterChange });

		fireEvent.click(screen.getByRole("button", { name: "Import files or folders" }));

		await waitFor(() => expect(toastError).toHaveBeenCalledWith("Import denied"), { timeout: 3000 });
		expect(onAfterChange).not.toHaveBeenCalled();
	});
});
