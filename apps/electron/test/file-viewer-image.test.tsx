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
