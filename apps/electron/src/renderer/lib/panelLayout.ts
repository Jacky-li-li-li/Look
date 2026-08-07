// ============================================================
// panelLayout — 右侧面板 / Dock 面板宽度解析（单一事实源）
//
// 所有面板显示宽度与拖拽上限的计算集中在这里，AppLayout /
// RightPanel / DockFilePanel 三处共用，避免各写一套导致口径漂移
// （2026-08-07 评审发现三处公式已不一致，且窄窗口会溢出裁剪）。
//
// 不变量（所有返回必须同时满足）：
//   1. 主内容区（main）宽度 >= MAIN_MIN_WIDTH（除非极端窗口连
//      main 都放不下，此时保 main 优先）
//   2. 面板总宽度不得超过视口 —— 绝不横向溢出/被 .app-shell
//      overflow-hidden 裁剪
//   3. 空间不足时的让位优先级：main > 右栏 > Dock
//      （先收缩右栏，再收缩 Dock；右栏归零仍不够时 Dock 使用
//      剩余全部空间）
// ============================================================

export const PANEL_LAYOUT = {
	/** 侧栏展开宽度（与 Sidebar / App.css --sidebar-track 保持一致） */
	SIDEBAR_WIDTH: 280,
	/** 侧栏与主区之间的分隔线宽度（--sidebar-sep-track：展开时 1px / 折叠时 0） */
	SEPARATOR_WIDTH: 1,
	/** 主内容区最小宽度（与 main min-w-[340px] 保持一致） */
	MAIN_MIN_WIDTH: 340,
	/** 右侧面板可拖拽宽度区间 */
	RIGHT_MIN: 200,
	RIGHT_MAX: 480,
	/** Dock 面板可拖拽宽度区间 */
	DOCK_MIN: 320,
	DOCK_MAX: 720,
} as const;

export interface PanelLayoutInput {
	/** 窗口可视宽度（px） */
	viewportWidth: number;
	sidebarCollapsed: boolean;
	rightPanelCollapsed: boolean;
	/** 用户拖拽后的右栏宽度（atom 值；显示值可能被压缩） */
	rightPanelWidth: number;
	/** Dock 面板是否打开 */
	dockOpen: boolean;
	/** 用户拖拽后的 Dock 宽度（atom 值；显示值可能被压缩） */
	dockPanelWidth: number;
}

export interface PanelLayout {
	sidebarWidth: number;
	/** 右侧面板实际显示宽度（0 = 折叠，或空间不足被虚拟折叠） */
	rightTrack: number;
	/** Dock 面板实际显示宽度（0 = 未打开） */
	dockTrack: number;
	/** 右栏可拖到的最大显示宽度（已扣除 Dock 下限所需空间） */
	rightMax: number;
	/** Dock 可拖到的最大显示宽度（受剩余空间限制） */
	dockMax: number;
}

function clamp(v: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, v));
}

export function resolvePanelTracks(input: PanelLayoutInput): PanelLayout {
	const sidebarWidth = input.sidebarCollapsed ? 0 : PANEL_LAYOUT.SIDEBAR_WIDTH;
	// 先保证 main 最小宽度 + 侧栏分隔线，剩余宽度在两个面板之间分配
	const separator = sidebarWidth > 0 ? PANEL_LAYOUT.SEPARATOR_WIDTH : 0;
	const pool = Math.max(0, input.viewportWidth - sidebarWidth - separator - PANEL_LAYOUT.MAIN_MIN_WIDTH);
	if (pool === 0) {
		return { sidebarWidth, rightTrack: 0, dockTrack: 0, rightMax: 0, dockMax: 0 };
	}

	const rightRequested = input.rightPanelCollapsed
		? 0
		: clamp(input.rightPanelWidth, PANEL_LAYOUT.RIGHT_MIN, PANEL_LAYOUT.RIGHT_MAX);
	const dockMin = input.dockOpen ? PANEL_LAYOUT.DOCK_MIN : 0;

	// 优先满足 Dock 下限：空间不足时收缩右栏（右栏优先级低于 Dock）
	let right = rightRequested;
	if (right + dockMin > pool) {
		right = Math.max(0, pool - dockMin);
	}
	right = Math.min(right, PANEL_LAYOUT.RIGHT_MAX);

	// 剩余空间给 Dock；右栏归零仍不够时 Dock 使用剩余全部（不裁剪、不溢出）
	const dockAvail = Math.max(0, pool - right);
	const dock = input.dockOpen
		? Math.min(clamp(input.dockPanelWidth, PANEL_LAYOUT.DOCK_MIN, PANEL_LAYOUT.DOCK_MAX), dockAvail)
		: 0;

	// 拖拽上限：右栏最大宽度 = 剩余空间 - Dock 下限；Dock 最大宽度 = 剩余空间
	const rightMax = input.rightPanelCollapsed ? 0 : Math.min(PANEL_LAYOUT.RIGHT_MAX, Math.max(0, pool - dockMin));
	const dockMax = input.dockOpen ? Math.min(PANEL_LAYOUT.DOCK_MAX, pool) : 0;

	return { sidebarWidth, rightTrack: right, dockTrack: dock, rightMax, dockMax };
}
