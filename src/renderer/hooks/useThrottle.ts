// ============================================================
// useThrottle — throttle a value for streaming performance
// ============================================================

import { useEffect, useRef, useState } from "react";

/**
 * Throttles a rapidly-changing value. During streaming, only updates
 * the output every `intervalMs` milliseconds, then flushes on completion.
 *
 * Strategy:
 *   streaming=true  → throttle at display refresh rate (every 16ms ≈ 60fps)
 *   streaming=false → update immediately (final render)
 */
export function useThrottle<T>(value: T, intervalMs: number, isStreaming: boolean): T {
	const [throttled, setThrottled] = useState(value);
	const lastUpdate = useRef<number>(null!);
	if (lastUpdate.current === null) lastUpdate.current = Date.now();
	const pending = useRef<T | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (!isStreaming) {
			if (timer.current) {
				clearTimeout(timer.current);
				timer.current = null;
			}
			setThrottled(value);
			return;
		}

		const now = Date.now();
		const elapsed = now - lastUpdate.current;

		if (elapsed >= intervalMs) {
			lastUpdate.current = now;
			setThrottled(value);
			pending.current = null;
			if (timer.current) {
				clearTimeout(timer.current);
				timer.current = null;
			}
		} else {
			// 只保留最新值，不清除已有 timer
			pending.current = value;
			if (!timer.current) {
				timer.current = setTimeout(() => {
					lastUpdate.current = Date.now();
					const latest = pending.current;
					pending.current = null;
					timer.current = null;
					if (latest !== null) {
						setThrottled(latest);
					}
				}, Math.max(0, intervalMs - elapsed));
			}
		}

		return () => {
			// 只清理 timer，保留 pending.current 以便 timer 回调获取最新值
			if (timer.current) {
				clearTimeout(timer.current);
				timer.current = null;
			}
		};
	}, [value, intervalMs, isStreaming]);

	return throttled;
}
