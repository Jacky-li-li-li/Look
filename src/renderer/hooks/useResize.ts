// ============================================================
// useResize — 受控宽度的水平拖拽 hook
// 参考 usePanZoom 的 window-level listener 模式(usePanZoom.ts:85-103)
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";

export type ResizeAxis = "east" | "west";

export interface UseResizeOptions {
	/** Current width value (controlled). */
	width: number;
	/** Called with the clamped next width while dragging. */
	onChange: (nextWidth: number) => void;
	/** Lower bound (inclusive). */
	min: number;
	/** Upper bound (inclusive). */
	max: number;
	/**
	 * Direction the panel grows.
	 * - "east": handle is on the panel's left edge; dragging left → width ↓
	 * - "west": handle is on the panel's right edge; dragging right → width ↓
	 */
	axis: ResizeAxis;
	/** Called on handle dblclick. */
	onReset?: () => void;
}

export interface UseResizeResult {
	/** Spread on the resize handle element. */
	handleProps: {
		onMouseDown: (e: React.MouseEvent) => void;
		onDoubleClick: (e: React.MouseEvent) => void;
	};
	/** True while a drag is in progress. */
	isDragging: boolean;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function useResize({ width, onChange, min, max, axis, onReset }: UseResizeOptions): UseResizeResult {
	const [isDragging, setIsDragging] = useState(false);
	// 拖拽起点信息(放在 ref 里,避免重渲染但 effect 能读到最新值)
	const startXRef = useRef(0);
	const startWidthRef = useRef(0);

	const onMouseDown = useCallback(
		(e: React.MouseEvent) => {
			// 阻止原生文本选择 / iframe drag
			e.preventDefault();
			e.stopPropagation();
			startXRef.current = e.clientX;
			startWidthRef.current = width;
			setIsDragging(true);
		},
		[width],
	);

	const onDoubleClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onReset?.();
		},
		[onReset],
	);

	// 拖拽中挂 window 监听;使用最新 width/onChange 闭包(用 ref 透传)
	const onChangeRef = useRef(onChange);
	const minRef = useRef(min);
	const maxRef = useRef(max);
	const axisRef = useRef(axis);
	onChangeRef.current = onChange;
	minRef.current = min;
	maxRef.current = max;
	axisRef.current = axis;

	useEffect(() => {
		if (!isDragging) return;

		const direction = axisRef.current === "east" ? 1 : -1;

		const onMouseMove = (e: MouseEvent) => {
			const delta = e.clientX - startXRef.current;
			const next = clamp(startWidthRef.current + delta * direction, minRef.current, maxRef.current);
			onChangeRef.current(next);
		};

		const onMouseUp = () => {
			setIsDragging(false);
		};

		// 阻止拖拽过程中选中文本 / 触发 drag
		const onSelectStart = (e: Event) => {
			e.preventDefault();
		};
		const onDragStart = (e: Event) => {
			e.preventDefault();
		};

		// 锁定 body 光标与选区
		const previousCursor = document.body.style.cursor;
		const previousUserSelect = document.body.style.userSelect;
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";

		window.addEventListener("mousemove", onMouseMove);
		window.addEventListener("mouseup", onMouseUp);
		window.addEventListener("selectstart", onSelectStart);
		window.addEventListener("dragstart", onDragStart);

		return () => {
			window.removeEventListener("mousemove", onMouseMove);
			window.removeEventListener("mouseup", onMouseUp);
			window.removeEventListener("selectstart", onSelectStart);
			window.removeEventListener("dragstart", onDragStart);
			document.body.style.cursor = previousCursor;
			document.body.style.userSelect = previousUserSelect;
		};
	}, [isDragging]);

	return {
		handleProps: {
			onMouseDown,
			onDoubleClick,
		},
		isDragging,
	};
}
