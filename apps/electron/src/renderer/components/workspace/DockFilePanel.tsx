// ============================================================
// DockFilePanel — 主窗口右侧 Dock 面板
//
// 由 dockedFileAtom 驱动：独立查看器窗口"合并到主窗口"或工作区
// 在 Dock 模式下点击文件时打开。容器常驻 AppLayout（grid 第 5 列
// --dock-track 控制宽度），有文件时渲染 FileViewerDialog(dockMode)。
// 顶部工具栏提供"弹出为独立窗口"与关闭能力。
// ============================================================

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useViewportWidth } from "../../hooks/useViewportWidth";
import { PANEL_LAYOUT, resolvePanelTracks } from "../../lib/panelLayout";
import { appStore } from "../../store/appStore";
import {
	dockedFileAtom,
	dockPanelWidthAtom,
	rightPanelCollapsedAtom,
	rightPanelWidthAtom,
	sidebarEffectiveCollapsedAtom,
} from "../../store/atoms";
import FileViewerDialog from "../dialogs/FileViewerDialog";
import { PanelResizeHandle } from "./PanelResizeHandle";

export function DockFilePanel() {
	const { t } = useTranslation();
	const dockedFile = useAtomValue(dockedFileAtom);
	const setDockedFile = useSetAtom(dockedFileAtom);
	const [dockPanelWidth, setDockPanelWidth] = useAtom(dockPanelWidthAtom);
	const [rightPanelWidth, setRightPanelWidth] = useAtom(rightPanelWidthAtom);
	const rightPanelCollapsed = useAtomValue(rightPanelCollapsedAtom);
	const sidebarCollapsed = useAtomValue(sidebarEffectiveCollapsedAtom);
	const viewportWidth = useViewportWidth();

	// 弹出为独立窗口：先打开独立窗口（淡入），再清空面板（滑出），两动画同步。
	// diffPatch 随窗口传递：独立窗口据此直接渲染完整文件 diff，不依赖自动检测。
	// 用 appStore.get 读最新值，避免闭包捕获过期路径。
	const handleUndock = useCallback(() => {
		const current = appStore.get(dockedFileAtom);
		if (!current) return;
		void window.look.openFileViewer(current.absolutePath, true, current.diffPatch);
		setDockedFile(null);
	}, [setDockedFile]);

	// 稳定回调身份：避免 FileViewerDialog 的依赖回调在每次重渲染时解绑重绑
	const handleDockNavigate = useCallback((path: string) => setDockedFile({ absolutePath: path }), [setDockedFile]);
	const handleDockClose = useCallback(() => setDockedFile(null), [setDockedFile]);

	// 面板宽度解析统一走 resolvePanelTracks（单一事实源）
	const layout = resolvePanelTracks({
		viewportWidth,
		sidebarCollapsed,
		rightPanelCollapsed,
		rightPanelWidth,
		dockOpen: !!dockedFile,
		dockPanelWidth,
	});

	// Splitter 语义：拖动 Dock 把手时，右栏与 Dock 互相让位、main 保持不变。
	// 右栏折叠（track=0）时退化为“Dock 对 main 调宽”。这是用户对“两块面板之间
	// 的分隔条”的直觉预期：拖左 = Dock 变宽 + 右栏变窄，拖右反之。
	// 依赖只取 layout 的原始数值（rightTrack/dockTrack），回调身份在数值不变时稳定。
	const handleDockResize = useCallback(
		(nextDock: number) => {
			// 右栏折叠或当前无显示宽度：仅改 Dock，吃/让 main 空间
			if (rightPanelCollapsed || layout.rightTrack === 0) {
				setDockPanelWidth(nextDock);
				return;
			}
			const delta = nextDock - layout.dockTrack;
			let nextRight = layout.rightTrack - delta;
			let dock = nextDock;
			// 右栏让到下限仍不够：封顶 dock，不再继续占
			if (nextRight < PANEL_LAYOUT.RIGHT_MIN) {
				nextRight = PANEL_LAYOUT.RIGHT_MIN;
				dock = layout.dockTrack + (layout.rightTrack - PANEL_LAYOUT.RIGHT_MIN);
			} else if (nextRight > PANEL_LAYOUT.RIGHT_MAX) {
				nextRight = PANEL_LAYOUT.RIGHT_MAX;
				dock = layout.dockTrack + (layout.rightTrack - PANEL_LAYOUT.RIGHT_MAX);
			}
			// Dock 自身边界
			dock = Math.min(PANEL_LAYOUT.DOCK_MAX, Math.max(PANEL_LAYOUT.DOCK_MIN, dock));
			setDockPanelWidth(dock);
			setRightPanelWidth(nextRight);
		},
		[rightPanelCollapsed, layout.rightTrack, layout.dockTrack, setDockPanelWidth, setRightPanelWidth],
	);

	return (
		<aside
			className={`dock-panel-wrapper relative flex h-full min-w-0 flex-col overflow-hidden bg-background ${dockedFile ? "border-l" : ""}`}
			data-open={!!dockedFile}
			aria-label={t("fileViewer.windowTitle")}
			inert={!dockedFile || undefined}
		>
			{/* 拖拽调宽把手：面板左侧边缘（= 右栏与 Dock 之间的分隔条）。
			    打开即渲染，不再因显示被压缩而隐藏——压缩时仍可拖动重新分配。 */}
			{dockedFile && layout.dockTrack > 0 && (
				<PanelResizeHandle
					cssVar="--dock-track"
					width={layout.dockTrack}
					min={PANEL_LAYOUT.DOCK_MIN}
					max={layout.dockMax}
					onCommit={handleDockResize}
					ariaLabel={t("fileViewer.resize")}
				/>
			)}
			{dockedFile && (
				<FileViewerDialog
					dockMode
					dockPath={dockedFile.absolutePath}
					dockDiffPatch={dockedFile.diffPatch}
					onDockNavigate={handleDockNavigate}
					onDockClose={handleDockClose}
					onDockUndock={handleUndock}
				/>
			)}
		</aside>
	);
}
