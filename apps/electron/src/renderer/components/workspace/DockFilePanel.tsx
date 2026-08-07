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
	sidebarCollapsedAtom,
} from "../../store/atoms";
import FileViewerDialog from "../dialogs/FileViewerDialog";
import { PanelResizeHandle } from "./PanelResizeHandle";

export function DockFilePanel() {
	const { t } = useTranslation();
	const dockedFile = useAtomValue(dockedFileAtom);
	const setDockedFile = useSetAtom(dockedFileAtom);
	const [dockPanelWidth, setDockPanelWidth] = useAtom(dockPanelWidthAtom);
	const rightPanelWidth = useAtomValue(rightPanelWidthAtom);
	const rightPanelCollapsed = useAtomValue(rightPanelCollapsedAtom);
	const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
	const viewportWidth = useViewportWidth();

	// 弹出为独立窗口：先打开独立窗口（淡入），再清空面板（滑出），两动画同步。
	// 用 appStore.get 读最新值，避免闭包捕获过期路径。
	const handleUndock = useCallback(() => {
		const current = appStore.get(dockedFileAtom);
		if (!current) return;
		void window.look.openFileViewer(current.absolutePath, true);
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
	// 显示宽度被空间压缩（显示 != 用户宽度）时隐藏调宽把手，避免“拖了没反应”
	const dockClamped = layout.dockTrack !== dockPanelWidth;

	return (
		<aside
			className={`dock-panel-wrapper relative flex h-full min-w-0 flex-col overflow-hidden bg-background ${dockedFile ? "border-l" : ""}`}
			data-open={!!dockedFile}
			aria-label={t("fileViewer.windowTitle")}
			inert={!dockedFile || undefined}
		>
			{/* 拖拽调宽把手：面板左侧边缘，收起或显示被压缩时不可用 */}
			{dockedFile && !dockClamped && layout.dockTrack > 0 && (
				<PanelResizeHandle
					cssVar="--dock-track"
					width={layout.dockTrack}
					min={PANEL_LAYOUT.DOCK_MIN}
					max={layout.dockMax}
					onCommit={setDockPanelWidth}
					ariaLabel={t("fileViewer.resize")}
				/>
			)}
			{dockedFile && (
				<FileViewerDialog
					dockMode
					dockPath={dockedFile.absolutePath}
					onDockNavigate={handleDockNavigate}
					onDockClose={handleDockClose}
					onDockUndock={handleUndock}
				/>
			)}
		</aside>
	);
}
