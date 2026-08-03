// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ToolCallCard from "../src/renderer/components/chat/ToolCallCard";
import ImagePreviewDialog from "../src/renderer/components/dialogs/ImagePreviewDialog";
import i18n from "../src/renderer/i18n";
import { appStore } from "../src/renderer/store/appStore";
import { imagePreviewAtom } from "../src/renderer/store/projectAtoms";

const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

describe("聊天图片放大预览", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("zh");
		appStore.set(imagePreviewAtom, null);
	});

	afterEach(() => {
		cleanup();
	});

	it("sets the preview atom when a tool result image is clicked", () => {
		render(
			<Provider store={appStore}>
				<ToolCallCard
					toolCall={{
						callId: "c1",
						toolName: "computer_screenshot",
						args: {},
						status: "success",
						result: { content: [{ type: "image", data: pngBase64, mimeType: "image/png" }] },
					}}
				/>
			</Provider>,
		);
		fireEvent.click(screen.getByRole("button", { name: "View tool result image 1" }));
		expect(appStore.get(imagePreviewAtom)).toEqual({
			src: `data:image/png;base64,${pngBase64}`,
			alt: "Tool result 1",
		});
	});

	it("renders the enlarged image when the preview atom is set", () => {
		appStore.set(imagePreviewAtom, { src: `data:image/png;base64,${pngBase64}`, alt: "Tool result 1" });
		render(
			<Provider store={appStore}>
				<ImagePreviewDialog />
			</Provider>,
		);
		expect(screen.getByAltText("Tool result 1").getAttribute("src")).toBe(`data:image/png;base64,${pngBase64}`);
	});
});
