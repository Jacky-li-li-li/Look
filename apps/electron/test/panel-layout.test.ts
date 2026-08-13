// ============================================================
// panelLayout 纯函数单测
//
// 覆盖 2026-08-07 评审发现的窄窗口裁剪缺陷：任意视口宽度下
// 面板总宽不得溢出、main 不得低于 340px、右栏让位 Dock 的优先级。
// ============================================================

import { describe, expect, it } from "vitest";
import {
	linkedDockTrack,
	linkedRightTrack,
	PANEL_LAYOUT,
	type PanelLayoutInput,
	resolvePanelTracks,
} from "../src/renderer/lib/panelLayout";

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
		expect(l.rightMax).toBe(640);
	});

	it("Dock 打开时右栏与 Dock 都按用户宽度显示，main 仍有富余", () => {
		const l = tracks(1440, { dockOpen: true });
		expect(l.rightTrack).toBe(260);
		expect(l.dockTrack).toBe(420);
		expectNoOverflow(l, 1440);
	});

	it("Dock 打开时给出各自的拖拽上限（右栏扣除 Dock 下限、Dock 按右栏让到下限的口径）", () => {
		const l = tracks(1440, { dockOpen: true });
		// rightMax = min(RIGHT_MAX=640, pool - dockMin=819-320=499) = 499
		expect(l.rightMax).toBe(499);
		// pool = 1440 - 280(侧栏) - 1(分隔线) - 340(main) = 819
		expect(l.pool).toBe(819);
		// live 口径（2026-08 修复撞墙回弹）：dock 拖到右栏让到下限为止，
		// dockMax = dock(420) + right(260) - RIGHT_MIN(200) = 480 ——
		// 拖拽中与松手后一致，不再出现“拖到 619、松手回弹 480”的跳变
		expect(l.dockMax).toBe(480);
		// dockMin = max(DOCK_MIN=320, dock + right - RIGHT_MAX=40) = 320
		expect(l.dockMin).toBe(320);
	});

	it("右栏已到下限时 Dock 把手冻结（dockMax === dockMin === dockTrack）", () => {
		const l = tracks(1440, { dockOpen: true, rightPanelWidth: 200, dockPanelWidth: 320 });
		expect(l.rightTrack).toBe(200);
		expect(l.dockTrack).toBe(320);
		// 右栏无法再让，Dock 也无法再缩 → 无可移动区间，把手应禁用
		expect(l.dockMax).toBe(320);
		expect(l.dockMin).toBe(320);
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

	it("被压缩时 rightMax/dockMax 反映实际可用空间（dockMax < dockMin，把手冻结禁用）", () => {
		const l = tracks(1100, { dockOpen: true });
		expect(l.rightMax).toBe(159);
		// pool = 1100 - 280 - 1 - 340 = 479；dockMax = 320 + 159 - 200(右栏下限) = 279
		expect(l.dockMax).toBe(279);
		// dockMin = max(320, 320 + 159 - 640) = 320 > dockMax → 倒挂，PanelResizeHandle 据此冻结
		expect(l.dockMin).toBe(320);
		expect(l.dockMax).toBeLessThan(l.dockMin);
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

	it("用户宽度被钳制到区间内（rightPanelWidth 超 640 / 低于 200）", () => {
		expect(tracks(1440, { rightPanelWidth: 600 }).rightTrack).toBe(600);
		expect(tracks(1440, { rightPanelWidth: 120 }).rightTrack).toBe(200);
	});
});

describe("联动宽度（拖拽中实时改写另一块面板的 track，与松手后 resolve 口径一致）", () => {
	it("linkedDockTrack：main 未触底时 Dock 保持存储宽度，触底后才让位", () => {
		// 1440px：right=260、dock=420，main 有 139px 富余
		const l = tracks(1440, { dockOpen: true });
		expect(linkedDockTrack(l, 360, 420, true)).toBe(420); // main 仍 ≥ 340，Dock 不动
		expect(linkedDockTrack(l, 399, 420, true)).toBe(420); // main 恰好 340
		expect(linkedDockTrack(l, 499, 420, true)).toBe(320); // main 触底，Dock 让到下限
		// 反方向收缩：Dock 恢复其存储宽度（镜像 resolve 的 dock=min(atom, pool-right)）
		expect(linkedDockTrack(l, 250, 420, true)).toBe(420);
		// Dock 关闭时不联动
		expect(linkedDockTrack(l, 360, 420, false)).toBe(0);
	});

	it("linkedRightTrack：Dock 拖动时右栏与 Dock 互相让位、main 不变，且被钳制在上下限内", () => {
		const l = tracks(1440, { dockOpen: true }); // right=260 dock=420
		expect(linkedRightTrack(l, 460)).toBe(220); // 拖左 40px：Dock +40、右栏 -40，和恒定
		expect(linkedRightTrack(l, 480)).toBe(200); // Dock 到 live 上限时右栏恰好到下限
		expect(linkedRightTrack(l, 380)).toBe(300); // 拖右：右栏回补
		expect(linkedRightTrack(l, 40)).toBe(640); // 右栏到上限（RIGHT_MAX）后 Dock 停止收缩
		expect(linkedRightTrack(l, 20)).toBe(640); // 钳制在 RIGHT_MAX，不再越界
	});
});
