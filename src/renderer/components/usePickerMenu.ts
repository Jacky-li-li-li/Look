// ============================================================
// usePickerMenu — 内联弹出菜单的共享容器逻辑
//
// 封装 click-outside 关闭、选中行滚动到视图、容器样式等
// SkillSlashMenu 和 AgentHashMenu 共有的 UI 行为。
// 不涉及状态机逻辑（open/filter/commit 保持在 ChatInput 中）。
// ============================================================

import { useCallback, useEffect, useRef } from "react";

export interface UsePickerMenuOptions {
	/** 可选项总数 */
	total: number;
	/** 当前选中索引（来自父组件 state） */
	selectedIndex: number;
	/** 关闭回调（Esc / click-outside） */
	onClose: () => void;
}

export interface PickerMenuRefs {
	clampedIndex: number;
	setRowRef: (i: number) => (el: HTMLButtonElement | null) => void;
}

const containerClassName =
	"absolute inset-x-0 bottom-full z-30 mb-1.5 overflow-hidden rounded-lg border border-hairline bg-card/95 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.18)] backdrop-blur-md";

function pickerMenuOnKeyDown(e: React.KeyboardEvent) {
	e.stopPropagation();
}

/**
 * 内联弹出菜单的共享容器 hook。
 *
 * 封装：
 * - click-outside 关闭（document "click" 事件，避开滚动条误触）
 * - 键盘事件冒泡阻止（stopPropagation）
 * - 选中行自动滚动到视图（scrollIntoView: nearest）
 * - 统一的容器样式（定位、毛玻璃、圆角、阴影）
 */
export function usePickerMenu(options: UsePickerMenuOptions): {
	menuRef: React.RefObject<HTMLDivElement | null>;
	containerClassName: string;
	onKeyDown: (e: React.KeyboardEvent) => void;
	refs: PickerMenuRefs;
} {
	const { total, selectedIndex, onClose } = options;

	const menuRef = useRef<HTMLDivElement>(null);

	// Click-outside 关闭。用 "click" 而非 "mousedown"：滚动条交互
	// 会触发 mousedown 导致误关闭，click 不会。
	useEffect(() => {
		const onDocClick = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				onClose();
			}
		};
		document.addEventListener("click", onDocClick);
		return () => document.removeEventListener("click", onDocClick);
	}, [onClose]);

	const clampedIndex = Math.max(0, Math.min(selectedIndex, total - 1));

	// 选中行自动滚动到视图
	const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
	useEffect(() => {
		rowRefs.current[clampedIndex]?.scrollIntoView({ block: "nearest" });
	}, [clampedIndex]);

	const setRowRef = useCallback(
		(i: number) => (el: HTMLButtonElement | null) => {
			rowRefs.current[i] = el;
		},
		[],
	);

	return {
		menuRef,
		containerClassName,
		onKeyDown: pickerMenuOnKeyDown,
		refs: { clampedIndex, setRowRef },
	};
}
