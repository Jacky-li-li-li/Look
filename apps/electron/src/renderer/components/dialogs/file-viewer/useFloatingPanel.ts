// ============================================================
// useFloatingPanel — 非模态浮窗的位置/尺寸与拖拽/缩放
//
// 仅 floating 模式（非 windowMode/dockMode）启用：组件常驻 AppLayout
// 不会卸载，跨文件打开自动保持位置/尺寸。
//
// 拆出自 FileViewerDialog：拖拽/缩放是纯交互关注点，且钳制逻辑
// （至少 80px 可见、最小 420×300）可被独立单测。
// ============================================================

import { type PointerEvent as ReactPointerEvent, useCallback, useState } from "react";

interface PanelPos {
	x: number;
	y: number;
}
interface PanelSize {
	width: number;
	height: number;
}

function initialPos(): PanelPos {
	const w = typeof window !== "undefined" ? window.innerWidth : 1280;
	const h = typeof window !== "undefined" ? window.innerHeight : 800;
	return {
		x: Math.max(16, Math.round((w - 896) / 2)),
		y: Math.max(16, Math.round(h * 0.08)),
	};
}

function initialSize(): PanelSize {
	const w = typeof window !== "undefined" ? window.innerWidth : 1280;
	const h = typeof window !== "undefined" ? window.innerHeight : 800;
	return {
		width: Math.min(896, w - 32),
		height: Math.round(h * 0.8),
	};
}

export interface UseFloatingPanelResult {
	pos: PanelPos;
	size: PanelSize;
	handleDragStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
	handleResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export function useFloatingPanel(enabled: boolean): UseFloatingPanelResult {
	const [pos, setPos] = useState<PanelPos>(initialPos);
	const [size, setSize] = useState<PanelSize>(initialSize);

	// 标题栏拖动：命中按钮等交互元素时不触发；钳制保证至少 80px 可见可拖回
	const handleDragStart = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (!enabled) return;
			if ((event.target as HTMLElement).closest("button, a, textarea, input, [role='separator']")) return;
			event.preventDefault();
			const startX = event.clientX;
			const startY = event.clientY;
			const origin = pos;
			const currentSize = size;
			const onMove = (ev: PointerEvent) => {
				setPos({
					x: Math.min(window.innerWidth - 80, Math.max(80 - currentSize.width, origin.x + ev.clientX - startX)),
					y: Math.min(window.innerHeight - 48, Math.max(0, origin.y + ev.clientY - startY)),
				});
			};
			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				document.body.style.userSelect = "";
			};
			document.body.style.userSelect = "none";
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[enabled, pos, size],
	);

	// 右下角缩放：最小 420×300，最大受视口约束
	const handleResizeStart = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (!enabled) return;
			event.preventDefault();
			event.stopPropagation();
			const startX = event.clientX;
			const startY = event.clientY;
			const origin = size;
			const currentPos = pos;
			const onMove = (ev: PointerEvent) => {
				setSize({
					width: Math.min(window.innerWidth - currentPos.x - 8, Math.max(420, origin.width + ev.clientX - startX)),
					height: Math.min(
						window.innerHeight - currentPos.y - 8,
						Math.max(300, origin.height + ev.clientY - startY),
					),
				});
			};
			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				document.body.style.userSelect = "";
			};
			document.body.style.userSelect = "none";
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[enabled, pos, size],
	);

	return { pos, size, handleDragStart, handleResizeStart };
}
