// ============================================================
// DockFilePanel — 主窗口右侧 Dock 面板（文件查看 / 内置浏览器）
//
// 由 dockedFileAtom（文件）与 browserPanelOpenAtom（浏览器）共同驱动：
// 任一打开时 Dock 展开（grid 第 5 列 --dock-track 控制宽度），顶部 tab 条
// 在两个内容之间切换；同时打开时 tab 条提供切换，新打开的一方自动激活。
// 文件 tab 渲染 FileViewerDialog(dockMode)；浏览器 tab 渲染 BrowserDockPanel
// （WebContentsView 原生视图经 BrowserSlot 布局上报）。
//
// 打开/关闭语义：
//   - 打开文件（合并独立窗口 / 工作区点文件）→ dockedFileAtom 置值，切到文件 tab；
//   - agent 使用浏览器 / 顶栏开关 → browserPanelOpenAtom 置值，切到浏览器 tab；
//   - 关闭当前 tab → 另一 tab 有内容则切过去，否则 Dock 收拢。
// ============================================================

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useViewportWidth } from "../../hooks/useViewportWidth";
import { linkedRightTrack, PANEL_LAYOUT, resolvePanelTracks } from "../../lib/panelLayout";
import { appStore } from "../../store/appStore";
import {
	dockActiveTabAtom,
	dockedFileAtom,
	dockPanelWidthAtom,
	rightPanelEffectiveCollapsedAtom,
	rightPanelWidthAtom,
	sidebarEffectiveCollapsedAtom,
} from "../../store/atoms";
import { browserPanelOpenAtom } from "../../store/browserAtoms";
import { BrowserDockPanel } from "../browser/BrowserDockPanel";
import FileViewerDialog from "../dialogs/FileViewerDialog";
import { PanelResizeHandle } from "./PanelResizeHandle";

export function DockFilePanel() {
	const { t } = useTranslation();
	const dockedFile = useAtomValue(dockedFileAtom);
	const setDockedFile = useSetAtom(dockedFileAtom);
	const browserOpen = useAtomValue(browserPanelOpenAtom);
	const [activeTab, setActiveTab] = useAtom(dockActiveTabAtom);
	const [dockPanelWidth, setDockPanelWidth] = useAtom(dockPanelWidthAtom);
	const [rightPanelWidth, setRightPanelWidth] = useAtom(rightPanelWidthAtom);
	// 必须读 effective（手动 OR 窄窗口自动折叠）：AppLayout/RightPanel 均按 effective
	// 折叠渲染（右栏 track=0），此前这里读手动态 rightPanelCollapsedAtom，自动折叠带
	// 下把手边界与重分配按“右栏仍可见”计算，拖动会把 Dock 拽出闪变并误改隐藏右栏
	// 的存储宽度（2026-08 修复）。
	const rightPanelCollapsed = useAtomValue(rightPanelEffectiveCollapsedAtom);
	const sidebarCollapsed = useAtomValue(sidebarEffectiveCollapsedAtom);
	const viewportWidth = useViewportWidth();

	const dockOpen = !!dockedFile || browserOpen;

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

	// 新打开的一方自动激活对应 tab（打开文件 → 文件 tab；agent 浏览 → 浏览器 tab）。
	useEffect(() => {
		if (dockedFile) setActiveTab("file");
	}, [dockedFile, setActiveTab]);
	useEffect(() => {
		if (browserOpen) setActiveTab("browser");
	}, [browserOpen, setActiveTab]);

	// 当前 tab 关闭后切到仍有内容的另一方；都没有则 Dock 收拢（activeTab 无需改）。
	useEffect(() => {
		if (activeTab === "file" && !dockedFile && browserOpen) setActiveTab("browser");
		if (activeTab === "browser" && !browserOpen && dockedFile) setActiveTab("file");
	}, [activeTab, dockedFile, browserOpen, setActiveTab]);

	// 面板宽度解析统一走 resolvePanelTracks（单一事实源）
	const layout = resolvePanelTracks({
		viewportWidth,
		sidebarCollapsed,
		rightPanelCollapsed,
		rightPanelWidth,
		dockOpen,
		dockPanelWidth,
	});

	// Splitter 语义：拖动 Dock 把手时，右栏与 Dock 互相让位、main 保持不变。
	// 拖拽期间由 PanelResizeHandle 的 linked（linkedRightTrack）实时改写右栏 track，
	// 松手时此处把两块面板的最终宽度一起落盘 —— 两个口径一致，无跳变。
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

	// 派生激活 tab：指向的内容不存在时回退到仍打开的一方，
	// 避免 activeTab 初始值（"file"）导致 agent 首开浏览器时面板空白。
	const fileTabActive = !!dockedFile && (activeTab === "file" || !browserOpen);
	const browserTabActive = browserOpen && (activeTab === "browser" || !dockedFile);

	return (
		<aside
			className={`dock-panel-wrapper relative flex h-full min-w-0 flex-col overflow-hidden bg-background ${dockOpen ? "border-l" : ""}`}
			data-open={dockOpen}
			aria-label={t("fileViewer.windowTitle")}
			inert={!dockOpen || undefined}
		>
			{/* Dock tab 条：文件 / 内置浏览器（仅任一内容打开时显示） */}
			{dockOpen && (
				<div className="flex h-7 shrink-0 items-center gap-0.5 border-b border-hairline px-1.5">
					<button
						type="button"
						className={`flex h-5 items-center gap-1 rounded px-2 text-[11px] transition-colors ${
							fileTabActive
								? "bg-accent/70 font-medium text-foreground"
								: dockedFile
									? "text-muted-foreground hover:bg-accent/40"
									: "cursor-default text-muted-foreground/40"
						}`}
						disabled={!dockedFile}
						onClick={() => setActiveTab("file")}
						title={dockedFile ? t("fileViewer.windowTitle") : undefined}
					>
						{t("fileViewer.windowTitle")}
					</button>
					<button
						type="button"
						className={`flex h-5 items-center gap-1 rounded px-2 text-[11px] transition-colors ${
							browserTabActive
								? "bg-accent/70 font-medium text-foreground"
								: browserOpen
									? "text-muted-foreground hover:bg-accent/40"
									: "cursor-default text-muted-foreground/40"
						}`}
						disabled={!browserOpen}
						onClick={() => setActiveTab("browser")}
						title={browserOpen ? t("browser.panelTitle") : undefined}
					>
						{t("browser.panelTitle")}
					</button>
				</div>
			)}

			{/* 拖拽调宽把手：面板左侧边缘（= 右栏与 Dock 之间的分隔条）。
			    打开即渲染，不再因显示被压缩而隐藏——压缩时仍可拖动重新分配。
			    min/max 用 live 口径（dockMin/dockMax）：拖拽中右栏与 Dock 互相让位、
			    main 不变，松手落盘与拖拽完全一致；右栏被压缩时 max < min，
			    PanelResizeHandle 自判冻结，不再闪变。 */}
			{dockOpen && layout.dockTrack > 0 && (
				<PanelResizeHandle
					cssVar="--dock-track"
					width={layout.dockTrack}
					min={layout.dockMin}
					max={layout.dockMax}
					linked={
						!rightPanelCollapsed && layout.rightTrack > 0
							? {
									cssVar: "--right-panel-track",
									map: (dock) => linkedRightTrack(layout, dock),
								}
							: undefined
					}
					onCommit={handleDockResize}
					ariaLabel={t("fileViewer.resize")}
				/>
			)}

			{/* 内容区：激活的 tab */}
			{fileTabActive && (
				<FileViewerDialog
					dockMode
					dockPath={dockedFile.absolutePath}
					dockDiffPatch={dockedFile.diffPatch}
					dockAttachment={dockedFile.attachment}
					onDockNavigate={handleDockNavigate}
					onDockClose={handleDockClose}
					onDockUndock={handleUndock}
				/>
			)}
			{browserTabActive && <BrowserDockPanel />}
		</aside>
	);
}
