// ============================================================
// LookThinkingOrb — thinking-orbs 绘制引擎的自驱动封装
//
// 直接用包的 resolvePreset + MODE_DRAWS 绘制，但**不用包内
// ThinkingOrb 组件**：包的组件用 IntersectionObserver 判定元素
// 在视口内才启动动画循环，而 LOOK 的流式滚动是弹簧跟随（内容
// 增长时状态行会短暂停在视口外），导致 orb 经常只画静态首帧。
// 这里自管 rAF：流式期间始终动画，效果与包完全一致。
//
// 相对包组件保持一致的细节：
//   - 循环启动前先同步画一帧，避免挂载瞬间的空白闪烁；
//   - 页面隐藏时暂停循环、恢复可见时续画（包通过 visibilitychange
//     做同样的事）——自驱动 ≠ 后台空转。
// ============================================================

import { useEffect, useRef } from "react";
import { MODE_DRAWS, type OrbSize, type OrbState, resolvePreset } from "thinking-orbs";

interface LookThinkingOrbProps {
	state: OrbState;
	/** 绘制预设尺寸（包只有 64 / 20 两个调校预设）。 */
	size: OrbSize;
	/** 预设速度倍率。 */
	speed?: number;
	/** true = 深色背景（亮色墨水）；false = 浅色背景（暗色墨水）。 */
	dark: boolean;
	/** CSS 显示尺寸，默认等于 size（可传一半以缩小显示）。 */
	displaySize?: number;
	"aria-label"?: string;
}

/** 每种状态的默认无障碍标签（与包内置文案一致）。satisfies 保证覆盖全部状态。 */
const DEFAULT_LABEL = {
	working: "Working…",
	searching: "Searching…",
	solving: "Solving…",
	listening: "Listening…",
	connecting: "Connecting…",
	weaving: "Weaving…",
	composing: "Composing…",
	breathing: "Thinking…",
	shaping: "Shaping…",
} as const satisfies Record<OrbState, string>;

export function LookThinkingOrb({
	state,
	size,
	speed = 1,
	dark,
	displaySize = size,
	"aria-label": ariaLabel,
}: LookThinkingOrbProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;

		const dpr = Math.min(2, typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1);
		canvas.width = Math.round(size * dpr);
		canvas.height = Math.round(size * dpr);
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const { mode, speed: baseSpeed, opts } = resolvePreset(state, size);
		const scaledSpeed = baseSpeed * speed;
		const draw = (t: number) => {
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, size, size);
			MODE_DRAWS[mode](ctx, size, t, dark, opts);
		};

		const reduceMotion = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (reduceMotion) {
			// 减少动效：静态代表性帧（与包行为一致）
			draw(0.6);
			return;
		}

		// 自管 rAF 状态机：running 控制是否续帧，配合页面可见性启停。
		let running = false;
		let rafId = 0;
		const loop = (now: number) => {
			draw((now / 1000) * scaledSpeed);
			if (running) rafId = requestAnimationFrame(loop);
		};
		const start = () => {
			if (running) return;
			running = true;
			rafId = requestAnimationFrame(loop);
		};
		const stop = () => {
			if (!running) return;
			running = false;
			cancelAnimationFrame(rafId);
		};

		// 首帧同步绘制：避免挂载瞬间 canvas 空白（与包行为一致）
		draw((performance.now() / 1000) * scaledSpeed);
		start();

		// 页面隐藏时暂停循环，恢复可见时续画（与包行为一致）
		const onVisibility = () => {
			if (document.visibilityState === "hidden") stop();
			else start();
		};
		document.addEventListener("visibilitychange", onVisibility);

		return () => {
			stop();
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [state, size, speed, dark]);

	return (
		<canvas
			ref={canvasRef}
			role="img"
			aria-label={ariaLabel ?? DEFAULT_LABEL[state]}
			style={{ width: displaySize, height: displaySize, display: "block" }}
		/>
	);
}
