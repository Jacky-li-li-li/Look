// @vitest-environment jsdom

import type { FileTreeNode } from "@shared/types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedAreaPanel } from "../src/renderer/components/workspace/SharedAreaPanel";
import i18n from "../src/renderer/i18n";
import { appStore } from "../src/renderer/store/appStore";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("sonner", () => ({
	toast: {
		error: toastError,
		info: vi.fn(),
		success: vi.fn(),
	},
}));

vi.mock("react-virtuoso", () => ({
	Virtuoso: ({ data, itemContent }: { data: FileTreeNode[]; itemContent: (index: number) => React.ReactNode }) => (
		<div>
			{data.map((_node, index) => (
				<div key={data[index].path}>{itemContent(index)}</div>
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

function renderPanel(overrides?: { files?: FileTreeNode[]; onAfterChange?: () => Promise<void> }) {
	return render(
		<Provider store={appStore}>
			<I18nextProvider i18n={i18n}>
				<SharedAreaPanel
					projectId="project-1"
					files={overrides?.files ?? files}
					isLoading={false}
					onAfterChange={overrides?.onAfterChange ?? vi.fn().mockResolvedValue(undefined)}
				/>
			</I18nextProvider>
		</Provider>,
	);
}

describe("SharedAreaPanel", () => {
	const writeSharedFile = vi.fn();
	const openFileDialog = vi.fn();
	const importToShared = vi.fn();

	beforeEach(async () => {
		await i18n.changeLanguage("en");
		toastError.mockReset();
		writeSharedFile.mockReset().mockResolvedValue({ success: true });
		openFileDialog.mockReset().mockResolvedValue({ success: true, paths: [] });
		importToShared.mockReset().mockResolvedValue({ success: true });
		Object.defineProperty(window, "look", {
			configurable: true,
			value: {
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
		expect(screen.getByRole("button", { name: "File: notes.md" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "More actions" })).toBeTruthy();
		expect(container.querySelector("button button")).toBeNull();
	});

	it("does not report a failed create result as success or close the creation input", async () => {
		const onAfterChange = vi.fn().mockResolvedValue(undefined);
		writeSharedFile.mockResolvedValue({ success: false, error: "Disk is read-only" });
		renderPanel({ files: [], onAfterChange });

		fireEvent.click(screen.getByRole("button", { name: "New file" }));
		const input = screen.getByPlaceholderText("File name");
		fireEvent.change(input, { target: { value: "draft.md" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(toastError).toHaveBeenCalledWith("Disk is read-only"));
		expect(onAfterChange).not.toHaveBeenCalled();
		expect(screen.getByPlaceholderText("File name")).toBeTruthy();
	});

	it("checks the import IPC result before refreshing or showing success", async () => {
		const onAfterChange = vi.fn().mockResolvedValue(undefined);
		openFileDialog.mockResolvedValue({ success: true, paths: ["/tmp/a.txt"] });
		importToShared.mockResolvedValue({ success: false, error: "Import denied" });
		renderPanel({ onAfterChange });

		fireEvent.click(screen.getByRole("button", { name: "Import files or folders" }));

		await waitFor(() => expect(toastError).toHaveBeenCalledWith("Import denied"));
		expect(onAfterChange).not.toHaveBeenCalled();
	});
});
