// ============================================================
// panelLayout 纯函数单测
//
// 覆盖 2026-08-07 评审发现的窄窗口裁剪缺陷：任意视口宽度下
// 面板总宽不得溢出、main 不得低于 340px、右栏让位 Dock 的优先级。
// ============================================================

import { describe, expect, it } from "vitest";
import { PANEL_LAYOUT, type PanelLayoutInput, resolvePanelTracks } from "../src/renderer/lib/panelLayout";

const BASE: PanelLayoutInput = {
	viewportWidth: 1440,
	sidebarCollapsed: false,
	rightPanelCollapsed: false,
	rightPanelWidth: 260,
	dockOpen: false,
	dockPanelWidth: 420,
};

function tracks(viewportWidth: number, patch: Partial<PanelLayoutInput> = {}): ReturnType<typeof resolvePanelTracks> {
	return resolvePanelTracks({ ...BASE, viewportWidth, ...patch });
}

/** 断言「不溢出 + main >= 340」这两个核心不变量。 */
function expectNoOverflow(layout: ReturnType<typeof resolvePanelTracks>, viewportWidth: number): void {
	const main = viewportWidth - layout.sidebarWidth - layout.rightTrack - layout.dockTrack;
	expect(layout.rightTrack).toBeGreaterThanOrEqual(0);
	expect(layout.dockTrack).toBeGreaterThanOrEqual(0);
	expect(main).toBeGreaterThanOrEqual(0);
	// 只要视口能放下 main 的下限，就必须保 main
	if (viewportWidth - layout.sidebarWidth >= PANEL_LAYOUT.MAIN_MIN_WIDTH) {
		expect(main).toBeGreaterThanOrEqual(PANEL_LAYOUT.MAIN_MIN_WIDTH);
	}
}

describe("resolvePanelTracks — 常规大屏", () => {
	it("Dock 关闭时右栏按用户宽度显示，Dock 为 0", () => {
		const l = tracks(1440, { rightPanelWidth: 300 });
		expect(l.rightTrack).toBe(300);
		expect(l.dockTrack).toBe(0);
		expect(l.rightMax).toBe(480);
	});

	it("Dock 打开时右栏与 Dock 都按用户宽度显示，main 仍有富余", () => {
		const l = tracks(1440, { dockOpen: true });
		expect(l.rightTrack).toBe(260);
		expect(l.dockTrack).toBe(420);
		expectNoOverflow(l, 1440);
	});

	it("Dock 打开时给出各自的拖拽上限（右栏扣除 Dock 下限、Dock 扣除右栏下限）", () => {
		const l = tracks(1440, { dockOpen: true });
		expect(l.rightMax).toBe(480);
		// pool = 1440 - 280(侧栏) - 1(分隔线) - 340(main) = 819；dockMax = 819 - 200(右栏下限) = 619
		expect(l.dockMax).toBe(619);
	});
});

describe("resolvePanelTracks — 窄窗口不裁剪（2026-08-07 修复核心）", () => {
	it("1140px：右栏收到 200 下限，Dock 320，main 恰为 340，无溢出", () => {
		const l = tracks(1140, { dockOpen: true });
		expect(l.rightTrack).toBe(199);
		expect(l.dockTrack).toBe(320);
		expectNoOverflow(l, 1140);
	});

	it("1100px：空间不足时右栏先收缩（160），Dock 保 320，main 340，无溢出", () => {
		const l = tracks(1100, { dockOpen: true });
		expect(l.rightTrack).toBe(159);
		expect(l.dockTrack).toBe(320);
		expectNoOverflow(l, 1100);
	});

	it("1050px：右栏继续收缩（110），仍无溢出", () => {
		const l = tracks(1050, { dockOpen: true });
		expect(l.rightTrack).toBe(109);
		expect(l.dockTrack).toBe(320);
		expectNoOverflow(l, 1050);
	});

	it("右栏折叠时 Dock 获得全部剩余空间", () => {
		const l = tracks(1100, { dockOpen: true, rightPanelCollapsed: true });
		expect(l.rightTrack).toBe(0);
		expect(l.dockTrack).toBe(420);
		expectNoOverflow(l, 1100);
	});

	it("侧栏折叠 + 右栏折叠 + Dock 打开：main 宽松", () => {
		const l = tracks(900, { sidebarCollapsed: true, rightPanelCollapsed: true, dockOpen: true });
		expect(l.rightTrack).toBe(0);
		expect(l.dockTrack).toBe(420);
		expectNoOverflow(l, 900);
	});

	it("窗口最小宽 900 且侧栏展开：右栏归零让位，Dock 用剩余空间，无溢出", () => {
		const l = tracks(900, { dockOpen: true });
		expect(l.rightTrack).toBe(0);
		expect(l.dockTrack).toBe(279);
		expectNoOverflow(l, 900);
	});

	it("极端窄窗口连 main 都放不下时，面板归零保 main", () => {
		const l = tracks(300, { dockOpen: true });
		expect(l.rightTrack).toBe(0);
		expect(l.dockTrack).toBe(0);
		expectNoOverflow(l, 300);
	});

	it("被压缩时 rightMax/dockMax 反映实际可用空间（把手据此隐藏）", () => {
		const l = tracks(1100, { dockOpen: true });
		expect(l.rightMax).toBe(159);
		// pool = 1100 - 280 - 1 - 340 = 479；dockMax = 479 - 200(右栏下限) = 279
		expect(l.dockMax).toBe(279);
	});
});

describe("resolvePanelTracks — 边界与组合", () => {
	it("Dock 关闭且窗口很窄（无 Dock 挤压）时右栏保持用户宽度", () => {
		const l = tracks(1000, { rightPanelWidth: 260 });
		expect(l.rightTrack).toBe(260);
		expect(l.dockTrack).toBe(0);
		expectNoOverflow(l, 1000);
	});

	it("dockPanelWidth 超出可用空间时被钳制到可用值", () => {
		const l = tracks(1100, { dockOpen: true, rightPanelCollapsed: true, dockPanelWidth: 500 });
		expect(l.dockTrack).toBe(479);
		expectNoOverflow(l, 1100);
	});

	it("用户宽度被钳制到区间内（rightPanelWidth 超 480 / 低于 200）", () => {
		expect(tracks(1440, { rightPanelWidth: 600 }).rightTrack).toBe(480);
		expect(tracks(1440, { rightPanelWidth: 120 }).rightTrack).toBe(200);
	});
});
