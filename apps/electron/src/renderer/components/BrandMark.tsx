// ============================================================
// BrandMark — Look 品牌标识（几何 L 标）
// 与 WelcomeScreen / LoginScreen 共享，作为应用的统一图标。
// ============================================================

import { cn } from "@look/ui";

interface BrandMarkProps {
	className?: string;
}

export function BrandMark({ className }: BrandMarkProps) {
	return (
		<div className={cn("brand-mark", className)}>
			<span className="text-4xl font-bold tracking-[0.15em] text-foreground">L</span>
		</div>
	);
}
