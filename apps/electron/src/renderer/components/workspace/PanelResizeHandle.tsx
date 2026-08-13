// ============================================================
// PanelResizeHandle — 面板拖拽调宽把手
//
// 绝对定位于面板内左侧。pointer 拖拽期间直接修改 .app-shell 的
// CSS 变量（即时跟手、不经过 React），松手后 onCommit 提交最终值
// 供 atom 持久化。setPointerCapture 保证指针移出窗口也不丢事件；
// 拖拽期间 .app-shell[data-resizing] 禁用 track 动画。
//
// 联动面板（linked）：拖拽中每帧同步写入联动面板的 CSS 变量，
// 实现“两面板互相让位、main 保持不变”的分隔条语义。map 必须镜像
// 松手后 resolve/commit 的口径（见 panelLayout.linkedDockTrack /
// linkedRightTrack），否则拖拽与最终布局不一致会出现跳变。
//
// 冻结（frozen）：当前宽度无法向任一方向移动时（压缩态下 min/max
// 倒挂或退化）把手自判禁用，避免拖动瞬间把 track 写成钳制值闪变。
//
// 性能要点（2026-08-09 重写）：
//  - 原生 window pointer 监听 + getCoalescedEvents()：合并子帧指针
//    点，120Hz/ProMotion 屏幕上不再每帧只取最后一个点，跟手更顺。
//  - requestAnimationFrame 合帧：一帧内多个 pointermove 只触发
//    一次 setProperty → 一次布局/绘制，避免热路径重排风暴。
//  - pointerdown 时缓存 .app-shell 引用，move 不再 querySelector。
//  - 解绑在 pointerup/pointercancel 即时移除 window 监听，零常驻
//    开销；组件卸载兜底清理 data-resizing 与 body 光标。
//  - 活跃监听的函数引用存入 ref，确保任意路径解绑都能 removeEventListener
//    到同一引用（避免 render N 添加 / render 0 卸载清理的引用错位）。
// ============================================================

import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";

/** 联动面板：拖拽期间与主面板一起让位的另一块面板。 */
export interface PanelResizeLinked {
	/** 联动面板的 .app-shell CSS 变量。 */
	cssVar: "--right-panel-track" | "--dock-track";
	/** 由主面板目标宽度推演联动面板显示宽度（必须已钳制到合法区间）。 */
	map: (primaryWidth: number) => number;
}

interface PanelResizeHandleProps {
	/** 要修改的 .app-shell CSS 变量。 */
	cssVar: "--right-panel-track" | "--dock-track";
	/** 当前宽度（px），pointerdown 时作为拖拽起点。 */
	width: number;
	min: number;
	max: number;
	/** 联动面板；主面板拖动时同步改写其 track（无联动需求时省略）。 */
	linked?: PanelResizeLinked;
	/** 拖拽结束提交最终宽度（持久化）。 */
	onCommit: (width: number) => void;
	ariaLabel: string;
}

export function PanelResizeHandle({ cssVar, width, min, max, linked, onCommit, ariaLabel }: PanelResizeHandleProps) {
	// 拖拽态全部走 ref，避免任何 React 状态参与热路径
	const draggingRef = useRef(false);
	const startRef = useRef<{ startX: number; startWidth: number; lastWidth: number; shell: HTMLElement } | null>(null);
	const rafIdRef = useRef<number | null>(null);
	// 最近一次合帧要落地的目标宽度；rAF 回调读它写 CSS 变量
	const pendingWidthRef = useRef<number | null>(null);
	// 记录 setProperty 上一次写入的值，相等则跳过，减少无谓样式重算
	const lastPrimaryRef = useRef<number | null>(null);
	const lastLinkedRef = useRef<number | null>(null);
	// 活跃 window 监听的函数引用；解绑时按引用移除，避免闭包错位
	const boundMoveRef = useRef<((e: PointerEvent) => void) | null>(null);
	const boundUpRef = useRef<((e: PointerEvent) => void) | null>(null);
	// pointerdown 时快照联动面板（map 闭包随 render 更新，拖拽期间必须保持起点口径）
	const linkedRef = useRef<PanelResizeLinked | null>(null);

	// 当前宽度是否无可移动区间（min/max 倒挂或退化为单点）：禁用把手，
	// 防止拖动瞬间把 track 写成钳制值造成闪变（2026-08 修复压缩态把手假死闪跳）。
	const frozen = max <= width && min >= width;

	const removeWindowListeners = () => {
		if (boundMoveRef.current) {
			window.removeEventListener("pointermove", boundMoveRef.current);
			boundMoveRef.current = null;
		}
		if (boundUpRef.current) {
			window.removeEventListener("pointerup", boundUpRef.current);
			window.removeEventListener("pointercancel", boundUpRef.current);
			boundUpRef.current = null;
		}
	};

	// 把 pending 宽度写入 CSS 变量（一帧最多一次）。相等跳过避免冗余样式重算
	const flush = () => {
		rafIdRef.current = null;
		const state = startRef.current;
		const shell = state?.shell;
		const w = pendingWidthRef.current;
		if (!shell || w == null) return;
		if (lastPrimaryRef.current !== w) {
			lastPrimaryRef.current = w;
			shell.style.setProperty(cssVar, `${w}px`);
		}
		// 联动面板：同一帧内同步改写其 track，分隔条语义下 main 全程不变
		const linkedPanel = linkedRef.current;
		if (linkedPanel) {
			const linkedWidth = linkedPanel.map(w);
			if (lastLinkedRef.current !== linkedWidth) {
				lastLinkedRef.current = linkedWidth;
				shell.style.setProperty(linkedPanel.cssVar, `${linkedWidth}px`);
			}
		}
	};

	const onPointerMove = (event: PointerEvent) => {
		if (!draggingRef.current) return;
		const state = startRef.current;
		if (!state) return;
		// getCoalescedEvents 在高刷新率屏幕上给出子帧精度；回退到单事件
		const events =
			typeof event.getCoalescedEvents === "function" && event.getCoalescedEvents().length > 0
				? event.getCoalescedEvents()
				: [event];
		// 取最后一个合帧点算目标宽度（与指针最新位置一致）
		const last = events[events.length - 1];
		const raw = state.startWidth - (last.clientX - state.startX);
		const next = Math.min(max, Math.max(min, raw));
		state.lastWidth = next;
		pendingWidthRef.current = next;
		// 合帧：若已有 rAF 排队则不重复调度
		if (rafIdRef.current == null) rafIdRef.current = requestAnimationFrame(flush);
	};

	const cleanupDrag = (): number | null => {
		draggingRef.current = false;
		const state = startRef.current;
		startRef.current = null;
		const shell = state?.shell ?? document.querySelector<HTMLElement>(".app-shell");
		if (shell) delete shell.dataset.resizing;
		document.body.style.userSelect = "";
		document.body.style.cursor = "";
		if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
		rafIdRef.current = null;
		pendingWidthRef.current = null;
		lastPrimaryRef.current = null;
		lastLinkedRef.current = null;
		linkedRef.current = null;
		return state?.lastWidth ?? null;
	};

	const onPointerUp = (event: PointerEvent) => {
		if (!draggingRef.current) return;
		const lastWidth = cleanupDrag();
		// 立即落地最终值（无 rAF），松手即定格
		if (lastWidth != null) onCommit(lastWidth);
		try {
			(event.target as Element).releasePointerCapture(event.pointerId);
		} catch {
			/* pointer capture 可能已自动释放 */
		}
		removeWindowListeners();
	};

	// 卸载兜底：拖拽中组件被卸载（窄窗口自动折叠/项目关闭）时清理全局副作用。
	// 不依赖任何 render 闭包：cleanupDrag / removeWindowListeners 只读 ref。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 仅作卸载清理，依赖空数组是有意为之，避免每次渲染重注册 effect
	useEffect(() => {
		return () => {
			if (!draggingRef.current) return;
			cleanupDrag();
			removeWindowListeners();
		};
	}, []);

	const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		if (frozen) return;
		event.preventDefault();
		event.stopPropagation();
		const shell = document.querySelector<HTMLElement>(".app-shell");
		if (!shell) return;
		// 指针捕获：移出窗口后 pointercancel 兜底；window 监听是主路径
		try {
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			/* 某些环境下 pointerId 已失效，忽略；window 监听兜底 */
		}
		draggingRef.current = true;
		startRef.current = { startX: event.clientX, startWidth: width, lastWidth: width, shell };
		pendingWidthRef.current = width;
		lastPrimaryRef.current = null;
		lastLinkedRef.current = null;
		// 快照联动面板：拖拽全程使用起点口径的 map，避免 render 更新切换闭包
		linkedRef.current = linked ?? null;
		shell.dataset.resizing = "true";
		document.body.style.userSelect = "none";
		document.body.style.cursor = "col-resize";
		// 热路径用原生 window 监听（passive），避免 React 合成事件代理开销，
		// 同时可直接访问 getCoalescedEvents()。同一 render 的闭包存入 ref，
		// 任何路径 removeEventListener 都拿到同一引用。
		boundMoveRef.current = onPointerMove;
		boundUpRef.current = onPointerUp;
		window.addEventListener("pointermove", onPointerMove, { passive: true });
		window.addEventListener("pointerup", onPointerUp, { passive: true });
		window.addEventListener("pointercancel", onPointerUp, { passive: true });
	};

	// React 事件兜底：lostpointercapture / pointercancel 仍由 React 派发时清理
	const endDragFromReact = () => {
		if (!draggingRef.current) return;
		cleanupDrag();
		removeWindowListeners();
	};

	return (
		<div
			className="panel-resize-handle"
			role="separator"
			aria-orientation="vertical"
			aria-label={ariaLabel}
			data-disabled={frozen || undefined}
			onPointerDown={handlePointerDown}
			onPointerCancel={endDragFromReact}
			onLostPointerCapture={endDragFromReact}
		/>
	);
}
