// ============================================================
// BrowserSlot — 内置浏览器原生视图的 renderer 侧占位
//
// 主进程把活动 tab 的 WebContentsView 作为原生层盖在 renderer
// DOM 之上（z-index 无法反转），所以 renderer 需要一个与原生视图
// 精确对齐的占位 div：本组件持续测量该 div 的布局，经
// `browser:set-layout` IPC 上报主进程 setBounds/setVisible。
//
// 参考 Proma 的 BrowserSlot 设计：
//   - rAF 循环测量（getBoundingClientRect），布局不变时不上报（去抖）；
//   - revision 全局单调递增（时间戳纪元），主进程忽略晚到的旧布局；
//   - 浮层检测：dialog / Sonner toast / Radix popper 打开时原生视图
//     必须临时隐藏，否则会盖住这些悬浮层（原生视图永远在 DOM 之上）；
//   - 卸载/失活时上报 visible:false，让主进程及时隐藏原生视图。
// ============================================================

import { useCallback, useEffect, useRef } from "react";
import { nextLayoutRevision } from "./browser-layout-revision";

interface BrowserSlotProps {
	/** 主进程浏览器会话 handle（来自 BrowserPanelState.handle）。 */
	handle: string | undefined;
	/** 会话内 tab 名。 */
	tab: string | undefined;
	/** 是否应该显示原生视图（面板打开、浏览器运行、且本 tab 为活动 tab）。 */
	active: boolean;
}

// 浮层选择器：仅模态对话框、Sonner toast 与 Look 全屏覆盖层（设置页等，data-look-overlay
// 标记）需要盖住一切（原生视图永远在 DOM 之上，这类浮层会被原生视图遮挡）。
// 注意**不要**包含 Radix Popper（data-radix-popper-content-wrapper）
// ——Tooltip / Dropdown 等瞬态浮层出现即隐藏视图会让页面闪烁（悬停按钮看提示时页面消失）。
const OVERLAY_SELECTORS = ['[role="dialog"]', "[data-sonner-toast]", "[data-look-overlay]"];

export function BrowserSlot({ handle, tab, active }: BrowserSlotProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const lastSentRef = useRef<{ visible: boolean; bounds: string } | null>(null);
	const overlayOpenRef = useRef(false);
	const activeRef = useRef(active);
	activeRef.current = active;

	/** 测量占位 div 并上报（布局不变时跳过，避免高频 IPC 刷屏）。 */
	const sendLayout = useCallback(() => {
		const container = containerRef.current;
		if (!handle || !tab || !container) return;
		const rect = container.getBoundingClientRect();
		const visible = activeRef.current && !overlayOpenRef.current && rect.width > 4 && rect.height > 4;
		// 主进程只关心整数 DIP；坐标取整既稳定又避免亚像素抖动导致反复 setBounds。
		const bounds = `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
		const last = lastSentRef.current;
		if (last && last.visible === visible && last.bounds === bounds) return;
		lastSentRef.current = { visible, bounds };
		void window.look
			.setAgentBrowserLayout({
				handle,
				tab,
				revision: nextLayoutRevision(),
				visible,
				bounds: {
					x: Math.round(rect.x),
					y: Math.round(rect.y),
					width: Math.round(rect.width),
					height: Math.round(rect.height),
				},
			})
			.catch((err: unknown) => {
				console.warn("[BrowserSlot] setAgentBrowserLayout failed:", err);
			});
	}, [handle, tab]);

	// 防御：handle/tab 切换后强制重新上报一次。
	// 同位置组件复用（无 key）时 lastSentRef 仍是旧 tab 的值，若占位 div 位置未变，
	// 首帧 sendLayout 会被去抖吞掉，主进程收不到新 tab 的 show 布局（视图不显示，
	// 直到布局变化才恢复）。声明在 rAF 循环之前，先于首帧执行。
	// biome-ignore lint/correctness/useExhaustiveDependencies: handle/tab 是触发重置的信号，effect 体通过 ref 读写不直接引用它们
	useEffect(() => {
		lastSentRef.current = null;
	}, [handle, tab]);

	// 测量循环：rAF 每帧检查一次，布局变化（面板拖宽/窗口缩放/内容布局迁移）
	// 自然被捕获；不变时不发 IPC。
	useEffect(() => {
		if (!handle || !tab) return;
		let raf = 0;
		const tick = () => {
			sendLayout();
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(raf);
		};
	}, [handle, tab, sendLayout]);

	// 浮层检测：dialog/toast 打开且盖住视图区时，原生视图必须临时隐藏
	// （原生视图永远在 DOM 之上，会遮挡这些浮层）；浮层关闭后恢复。
	// 只在与占位 div 实际相交时才隐藏，避免不相干浮层（如屏幕左侧的 toast）
	// 触发页面闪烁。MutationObserver 回调合入 rAF 节流：聊天流式输出等高频
	// DOM 变更不应逐次触发全文档查询 + 布局读取。
	useEffect(() => {
		let raf = 0;
		const checkOverlay = () => {
			raf = 0;
			const container = containerRef.current;
			const containerRect = container?.getBoundingClientRect();
			const open = OVERLAY_SELECTORS.some((selector) => {
				for (const el of document.querySelectorAll(selector)) {
					const r = el.getBoundingClientRect();
					if (r.width <= 0 || r.height <= 0) continue; // 未布局/隐藏中的浮层
					if (!containerRect) return true; // 容器不在 DOM 中，保守隐藏
					const intersects =
						r.left < containerRect.right &&
						r.right > containerRect.left &&
						r.top < containerRect.bottom &&
						r.bottom > containerRect.top;
					if (intersects) return true;
				}
				return false;
			});
			if (open !== overlayOpenRef.current) {
				overlayOpenRef.current = open;
				sendLayout();
			}
		};
		// rAF 合并：同一帧内的多次 mutation 只检查一次
		const scheduleCheck = () => {
			if (raf) return;
			raf = requestAnimationFrame(checkOverlay);
		};
		const observer = new MutationObserver(scheduleCheck);
		observer.observe(document.body, { childList: true, subtree: true });
		checkOverlay();
		return () => {
			observer.disconnect();
			if (raf) cancelAnimationFrame(raf);
		};
	}, [sendLayout]);

	// 窗口恢复可见（最小化/隐藏恢复、标签页切回）时强制重报一次：
	// 最小化期间主进程可能因 isVisible() 门隐藏视图并推进 revision，
	// 恢复后布局数值未变、去抖不会重发——必须主动重置 lastSentRef 重报。
	useEffect(() => {
		const onVisibilityChange = () => {
			if (document.visibilityState !== "visible") return;
			lastSentRef.current = null;
			sendLayout();
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => document.removeEventListener("visibilitychange", onVisibilityChange);
	}, [sendLayout]);

	// 卸载/切 tab：上报隐藏，让主进程立即把原生视图收起来
	// （不依赖主进程的 revision 清理路径）。
	useEffect(() => {
		return () => {
			if (handle && tab) {
				void window.look
					.setAgentBrowserLayout({
						handle,
						tab,
						revision: nextLayoutRevision(),
						visible: false,
						bounds: { x: 0, y: 0, width: 0, height: 0 },
					})
					.catch(() => {
						// 主进程已退出等场景，忽略
					});
			}
		};
	}, [handle, tab]);

	return <div ref={containerRef} className="h-full w-full" />;
}
