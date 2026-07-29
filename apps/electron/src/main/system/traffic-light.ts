// ============================================================
// Traffic light position (macOS)
//
// hiddenInset 红绿灯的位置由主进程控制，与渲染端 CSS 是两个互不知情
// 的坐标系；硬编码 y 一旦遇到顶部栏高度/布局变化就会错位。因此采用
// 正向推导：渲染端实测当前顶部栏的可视中心（CSS px），通过
// "window:traffic-light-center" 事件回传，主进程换算后调用
// setTrafficLightPosition。此处的常量是该换算的唯一事实来源。
// ============================================================

/** 红绿灯组件左边距（pt），与顶部栏 px-3（12px）留白对齐 */
export const TRAFFIC_LIGHT_X = 12;

/**
 * trafficLightPosition.y 是组件 top-left；实测（2x 屏逐像素测量）
 * 组件可视中心比 y 低约 6.75pt（组件总高约 13.5pt）。
 * 由目标中心反推 y 时减去该偏移。
 */
export const TRAFFIC_LIGHT_CENTER_OFFSET = 6.75;

/** 48px（h-12）顶部栏的估算初值；渲染端实测回传后会被校正 */
export const TRAFFIC_LIGHT_INITIAL_Y = 17;

/** 由顶部栏可视中心（pt）反推 setTrafficLightPosition 的 y */
export function trafficLightYForCenter(centerPt: number): number {
	return Math.round(centerPt - TRAFFIC_LIGHT_CENTER_OFFSET);
}
