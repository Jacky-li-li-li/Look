// ============================================================
// PanelResizeHandle — 面板拖拽调宽把手
//
// 绝对定位于面板内左侧。pointer 拖拽期间直接修改 .app-shell 的
// CSS 变量（即时跟手、不经过 React），松手后 onCommit 提交最终值
// 供 atom 持久化。setPointerCapture 保证指针移出窗口也不丢事件；
// 拖拽期间 .app-shell[data-resizing] 禁用 track 动画。
//
// 竞态防护：拖拽值记录在本地 ref（lastWidth），即使拖拽中 React 因
// 其他 atom 重渲染把 inline CSS 变量重置，endDrag 仍提交真实拖拽值；
// 组件卸载/失去指针捕获时通过 effect cleanup + lostpointercapture
// 兜底清理 data-resizing 与 body 光标，避免永久禁用动画。
// ============================================================

import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";

interface PanelResizeHandleProps {
	/** 要修改的 .app-shell CSS 变量。 */
	cssVar: "--right-panel-track" | "--dock-track";
	/** 当前宽度（px），pointerdown 时作为拖拽起点。 */
	width: number;
	min: number;
	max: number;
	/** 拖拽结束提交最终宽度（持久化）。 */
	onCommit: (width: number) => void;
	ariaLabel: string;
}

export function PanelResizeHandle({ cssVar, width, min, max, onCommit, ariaLabel }: PanelResizeHandleProps) {
	const draggingRef = useRef(false);
	const dragStateRef = useRef<{ startX: number; startWidth: number; lastWidth: number } | null>(null);

	// 卸载兜底：拖拽中组件被卸载（窄窗口自动折叠/项目关闭）时清理全局副作用
	useEffect(() => {
		return () => {
			if (!draggingRef.current) return;
			draggingRef.current = false;
			dragStateRef.current = null;
			const shell = document.querySelector<HTMLElement>(".app-shell");
			if (shell) delete shell.dataset.resizing;
			document.body.style.userSelect = "";
			document.body.style.cursor = "";
		};
	}, []);

	const cleanupDrag = () => {
		draggingRef.current = false;
		dragStateRef.current = null;
		const shell = document.querySelector<HTMLElement>(".app-shell");
		if (shell) delete shell.dataset.resizing;
		document.body.style.userSelect = "";
		document.body.style.cursor = "";
	};

	const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		const shell = document.querySelector<HTMLElement>(".app-shell");
		if (!shell) return;
		// 指针捕获：移出窗口后 pointermove/pointerup 仍派发给当前元素
		event.currentTarget.setPointerCapture(event.pointerId);
		draggingRef.current = true;
		dragStateRef.current = { startX: event.clientX, startWidth: width, lastWidth: width };
		shell.dataset.resizing = "true";
		document.body.style.userSelect = "none";
		document.body.style.cursor = "col-resize";
	};

	const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!draggingRef.current) return;
		const state = dragStateRef.current;
		const shell = document.querySelector<HTMLElement>(".app-shell");
		if (!state || !shell) return;
		// 把手在面板左边缘：向左拖（clientX 减小）= 面板变宽，取反
		const next = Math.min(max, Math.max(min, state.startWidth - (event.clientX - state.startX)));
		state.lastWidth = next;
		shell.style.setProperty(cssVar, `${next}px`);
	};

	const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!draggingRef.current) return;
		const state = dragStateRef.current;
		cleanupDrag();
		if (state) onCommit(state.lastWidth);
		try {
			event.currentTarget.releasePointerCapture(event.pointerId);
		} catch {
			/* pointer capture 可能已自动释放 */
		}
	};

	return (
		<div
			className="panel-resize-handle"
			role="separator"
			aria-orientation="vertical"
			aria-label={ariaLabel}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={endDrag}
			onPointerCancel={endDrag}
			onLostPointerCapture={cleanupDrag}
		/>
	);
}
