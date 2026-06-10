// ============================================================
// usePanZoom — pan & zoom with mouse/trackpad for diagram viewers
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";

interface PanZoomState {
	scale: number;
	x: number;
	y: number;
}

interface UsePanZoomOptions {
	minScale?: number;
	maxScale?: number;
	initialScale?: number;
}

export function usePanZoom({ minScale = 0.15, maxScale = 6, initialScale = 1 }: UsePanZoomOptions = {}) {
	const [state, setState] = useState<PanZoomState>({ scale: initialScale, x: 0, y: 0 });
	const [isPanning, setIsPanning] = useState(false);
	const lastPos = useRef({ x: 0, y: 0 });

	const update = useCallback(
		(fn: (prev: PanZoomState) => PanZoomState) => {
			setState((prev) => {
				const next = fn(prev);
				return {
					scale: Math.min(maxScale, Math.max(minScale, next.scale)),
					x: next.x,
					y: next.y,
				};
			});
		},
		[minScale, maxScale],
	);

	const reset = useCallback(() => {
		setState({ scale: initialScale, x: 0, y: 0 });
	}, [initialScale]);

	const zoomIn = useCallback(() => {
		update((prev) => ({ ...prev, scale: prev.scale * 1.25 }));
	}, [update]);

	const zoomOut = useCallback(() => {
		update((prev) => ({ ...prev, scale: prev.scale / 1.25 }));
	}, [update]);

	// Pinch-to-zoom + mousewheel.
	// stopPropagation prevents Virtuoso from capturing the wheel event
	// and scrolling the message list instead of zooming the diagram.
	const onWheel = useCallback(
		(e: React.WheelEvent<HTMLElement>) => {
			e.preventDefault();
			e.stopPropagation();
			const container = e.currentTarget as HTMLElement;
			const rect = container.getBoundingClientRect();
			const mx = e.clientX - rect.left;
			const my = e.clientY - rect.top;
			const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;

			update((prev) => {
				const newScale = Math.min(maxScale, Math.max(minScale, prev.scale * factor));
				return {
					scale: newScale,
					x: mx - (mx - prev.x) * (newScale / prev.scale),
					y: my - (my - prev.y) * (newScale / prev.scale),
				};
			});
		},
		[update, minScale, maxScale],
	);

	// Drag-to-pan. stopPropagation prevents Virtuoso from intercepting
	// the drag and scrolling the message list.
	const onMouseDown = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		setIsPanning(true);
		lastPos.current = { x: e.clientX, y: e.clientY };
	}, []);

	// Attach mousemove/mouseup to window so dragging continues
	// even when cursor leaves the container.
	useEffect(() => {
		if (!isPanning) return;

		const onMouseMove = (e: MouseEvent) => {
			const dx = e.clientX - lastPos.current.x;
			const dy = e.clientY - lastPos.current.y;
			lastPos.current = { x: e.clientX, y: e.clientY };
			update((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
		};

		const onMouseUp = () => setIsPanning(false);

		window.addEventListener("mousemove", onMouseMove);
		window.addEventListener("mouseup", onMouseUp);
		return () => {
			window.removeEventListener("mousemove", onMouseMove);
			window.removeEventListener("mouseup", onMouseUp);
		};
	}, [update, isPanning]);

	// Double-click to reset
	const onDoubleClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			reset();
		},
		[reset],
	);

	// Keyboard shortcuts: Ctrl/Cmd + = for zoom in, - for zoom out, 0 to reset
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey;
			if (!mod) return;
			if (e.key === "=") {
				e.preventDefault();
				zoomIn();
			} else if (e.key === "-") {
				e.preventDefault();
				zoomOut();
			} else if (e.key === "0") {
				e.preventDefault();
				reset();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [zoomIn, zoomOut, reset]);

	const cursorClass = isPanning ? "cursor-grabbing" : "cursor-grab";

	return {
		state,
		reset,
		zoomIn,
		zoomOut,
		containerProps: {
			style: {
				transform: `translate(${state.x}px, ${state.y}px) scale(${state.scale})`,
				transformOrigin: "0 0",
			},
		},
		wrapperProps: {
			onWheel,
			onMouseDown,
			onDoubleClick,
			className: `overflow-hidden ${cursorClass} select-none`,
		},
		cursorClass,
	};
}
