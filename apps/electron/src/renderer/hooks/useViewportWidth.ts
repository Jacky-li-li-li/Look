// ============================================================
// useViewportWidth — 跟踪窗口可视宽度（px）
//
// 用于面板拖拽调宽的动态上限计算：Dock/右侧面板不能把
// 主内容区（最小 340px）挤压出视口。
//
// 性能要点（2026-08-09 重写）：
//  - resize 用 requestAnimationFrame 合帧，避免每个 resize 事件
//    都触发 setState → RightPanel/DockFilePanel/AppLayout 三处全量
//    重渲染（拖窗口边时一秒几十次）。
//  - 期间给 .app-shell 打 data-window-resizing，让 CSS 临时禁用
//    grid track 过渡动画；拖窗口边时面板不再"追着"动画发飘。
//  - 停止 resize 后短延时清掉标记，恢复过渡。
// ============================================================

import { useEffect, useState } from "react";

const RESIZE_SETTLE_MS = 220;

export function useViewportWidth(): number {
	const [width, setWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1400));
	useEffect(() => {
		let rafId: number | null = null;
		let settleTimer: ReturnType<typeof setTimeout> | null = null;
		const markResizing = () => {
			const shell = document.querySelector<HTMLElement>(".app-shell");
			if (shell) shell.dataset.windowResizing = "true";
			if (settleTimer) clearTimeout(settleTimer);
			// 停止 resize 一段时间后再清标记，让最后一次过渡平滑恢复
			settleTimer = setTimeout(() => {
				const s = document.querySelector<HTMLElement>(".app-shell");
				if (s) delete s.dataset.windowResizing;
			}, RESIZE_SETTLE_MS);
		};
		const onResize = () => {
			markResizing();
			if (rafId != null) return; // 已排队则复用，本帧只 setState 一次
			rafId = requestAnimationFrame(() => {
				rafId = null;
				setWidth(window.innerWidth);
			});
		};
		window.addEventListener("resize", onResize, { passive: true });
		return () => {
			window.removeEventListener("resize", onResize);
			if (rafId != null) cancelAnimationFrame(rafId);
			if (settleTimer) clearTimeout(settleTimer);
			const s = document.querySelector<HTMLElement>(".app-shell");
			if (s) delete s.dataset.windowResizing;
		};
	}, []);
	return width;
}
