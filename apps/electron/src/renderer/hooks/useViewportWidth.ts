// ============================================================
// useViewportWidth — 跟踪窗口可视宽度（px）
//
// 用于面板拖拽调宽的动态上限计算：Dock/右侧面板不能把
// 主内容区（最小 340px）挤压出视口。
// ============================================================

import { useEffect, useState } from "react";

export function useViewportWidth(): number {
	const [width, setWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1400));
	useEffect(() => {
		const onResize = () => setWidth(window.innerWidth);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);
	return width;
}
