// ============================================================
// Traffic light 垂直对齐（macOS）
//
// hiddenInset 红绿灯的位置由主进程 setTrafficLightPosition 控制，与
// 渲染端 CSS 互不知情；硬编码偏移一旦遇到顶部栏高度/布局变化就会错位。
// 这里正向处理：实测当前可见顶部栏（窗口最上方的 <header>）的可视中心
// 并回传主进程，由主进程反推红绿灯 y（换算见 main/system/traffic-light.ts）。
// ============================================================

/**
 * 窗口最上方、实际可见且最靠左的顶部栏的内容盒中心（CSS px，相对视口顶）；
 * 找不到返回 null。
 *
 * 对齐对象取"最靠左"的栏：红绿灯位于窗口最左侧，侧栏展开时它叠在侧栏
 * header 上，折叠时叠在标签栏上。两个坑必须避开：
 * - 折叠侧栏的 header 仍留在 DOM，但被平移出画布（left<0），需按 right 过滤；
 * - getBoundingClientRect 是 border-box，含 1px border-b，而栏内按钮按
 *   内容盒居中——不扣除会系统性偏低 0.5px。
 */
function measureTopBarCenter(): number | null {
	let best: { left: number; center: number } | null = null;
	for (const el of document.querySelectorAll("header")) {
		const r = el.getBoundingClientRect();
		if (r.height < 20 || r.width < 40 || r.top >= 2 || r.bottom <= 2 || r.right <= 2) continue;
		const borderBottom = parseFloat(getComputedStyle(el).borderBottomWidth) || 0;
		const center = r.top + (r.height - borderBottom) / 2;
		if (!best || r.left < best.left) best = { left: r.left, center };
	}
	return best?.center ?? null;
}

/**
 * 实测顶部栏中心并通过 "window:traffic-light-center" 回传主进程。
 * 仅 macOS 需要（其他平台无 hiddenInset 红绿灯）；找不到顶部栏时
 * 保持主进程的初始估算值不动。
 *
 * 调用时机：挂载后（rAF 内，等布局稳定）、窗口 resize，以及任何会
 * 替换当前顶部栏的视图切换（侧栏折叠、Agent 广场、定时任务页等）。
 */
export function syncTrafficLightPosition(): void {
	if (window.look?.platform !== "darwin") return;
	const center = measureTopBarCenter();
	if (center != null) {
		window.look.send({ type: "window:traffic-light-center", centerCssPx: center });
	}
}
