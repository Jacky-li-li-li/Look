// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activeProjectIdAtom,
	DEFAULT_RIGHT_PANEL_WIDTH,
	MAX_RIGHT_PANEL_WIDTH,
	MIN_RIGHT_PANEL_WIDTH,
	projectsAtom,
	rightPanelCollapsedAtom,
	rightPanelWidthAtom,
} from "../src/renderer/store/atoms";
import { appStore } from "../src/renderer/store/ipcHandler";

// Mock heavy child panels so RightPanel renders in isolation
vi.mock("../src/renderer/components/WorkspaceTreePanel", () => ({
	WorkspaceTreePanel: () => <div data-testid="workspace-tree-stub" />,
}));
vi.mock("../src/renderer/components/SharedAreaPanel", () => ({
	SharedAreaPanel: () => <div data-testid="shared-area-stub" />,
}));

import { RightPanel } from "../src/renderer/components/RightPanel";

const testProject = {
	id: "p1",
	name: "Test",
	cwd: "/tmp/test",
	createdAt: 1,
	valid: true,
};

beforeEach(() => {
	// Reset width + collapse + active project to known state
	appStore.set(rightPanelWidthAtom, DEFAULT_RIGHT_PANEL_WIDTH);
	appStore.set(rightPanelCollapsedAtom, false);
	appStore.set(projectsAtom, [testProject]);
	appStore.set(activeProjectIdAtom, testProject.id);

	// Stub window.look (RightPanel kicks off shared-files fetch + watcher)
	(globalThis as unknown as { window: { look: unknown } }).window.look = {
		listSharedFiles: vi.fn().mockResolvedValue({ success: true, nodes: [] }),
		startSharedWatch: vi.fn().mockResolvedValue(undefined),
		stopSharedWatch: vi.fn().mockResolvedValue(undefined),
	};
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function renderPanel() {
	return render(
		<Provider store={appStore}>
			<RightPanel />
		</Provider>,
	);
}

describe("RightPanel — resize + collapse reset", () => {
	it("renders the panel at default width when not collapsed", () => {
		const { container } = renderPanel();
		const aside = container.querySelector("aside.right-panel-wrapper") as HTMLElement;
		expect(aside).toBeTruthy();
		// collapsed = false → inline style width = DEFAULT
		expect(aside.style.width).toBe(`${DEFAULT_RIGHT_PANEL_WIDTH}px`);
		expect(aside.dataset.collapsed).toBe("false");
	});

	it("renders the resize handle inside the aside", () => {
		const { container } = renderPanel();
		const handle = container.querySelector(".right-panel-resize-handle");
		expect(handle).toBeTruthy();
	});

	it("clamps width at min and max during drag", () => {
		const { container } = renderPanel();
		const handle = container.querySelector(".right-panel-resize-handle") as HTMLElement;
		expect(handle).toBeTruthy();

		// mousedown 起点
		fireEvent.mouseDown(handle, { clientX: 500 });

		// 拖右 1000px → 260 + 1000 = 1260,夹到 MAX
		fireEvent.mouseMove(window, { clientX: 1500 });
		expect(appStore.get(rightPanelWidthAtom)).toBe(MAX_RIGHT_PANEL_WIDTH);

		// 拖回起点 clientX=500 → delta=0,260
		fireEvent.mouseMove(window, { clientX: 500 });
		expect(appStore.get(rightPanelWidthAtom)).toBe(DEFAULT_RIGHT_PANEL_WIDTH);

		// 拖左 400px(500 → 100) → 260 - 400 = -140,夹到 MIN
		fireEvent.mouseMove(window, { clientX: 100 });
		expect(appStore.get(rightPanelWidthAtom)).toBe(MIN_RIGHT_PANEL_WIDTH);

		// 释放
		fireEvent.mouseUp(window);
	});

	it("dblclick on handle resets width to default", () => {
		// 先拖到非默认值
		appStore.set(rightPanelWidthAtom, 450);

		const { container } = renderPanel();
		const handle = container.querySelector(".right-panel-resize-handle") as HTMLElement;
		fireEvent.doubleClick(handle);

		expect(appStore.get(rightPanelWidthAtom)).toBe(DEFAULT_RIGHT_PANEL_WIDTH);
	});

	it("collapsing the panel resets width to default", () => {
		appStore.set(rightPanelWidthAtom, 380);

		const { container } = renderPanel();
		// 折叠按钮:aria-label="折叠右侧面板"
		const collapseBtn = container.querySelector('button[aria-label="折叠右侧面板"]') as HTMLButtonElement;
		expect(collapseBtn).toBeTruthy();
		fireEvent.click(collapseBtn);

		// 折叠后 width 立即被重置为默认
		expect(appStore.get(rightPanelWidthAtom)).toBe(DEFAULT_RIGHT_PANEL_WIDTH);
		expect(appStore.get(rightPanelCollapsedAtom)).toBe(true);
	});

	it("collapsed state hides the handle (pointer-events none via class hook)", () => {
		appStore.set(rightPanelCollapsedAtom, true);
		const { container } = renderPanel();
		const aside = container.querySelector("aside.right-panel-wrapper") as HTMLElement;
		expect(aside.dataset.collapsed).toBe("true");
		// Handle 仍存在但其父容器会通过 CSS 给它 pointer-events: none
		const handle = container.querySelector(".right-panel-resize-handle");
		expect(handle).toBeTruthy();
	});
});
