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
	const lastUpdate = useRef(Date.now());
	const pending = useRef<T | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (!isStreaming) {
			// Not streaming → immediate update
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
			// Enough time passed → update now
			lastUpdate.current = now;
			setThrottled(value);
			pending.current = null;
		} else {
			// Too soon → schedule deferred update
			pending.current = value;
			if (!timer.current) {
				timer.current = setTimeout(() => {
					lastUpdate.current = Date.now();
					if (pending.current !== null) {
						setThrottled(pending.current);
						pending.current = null;
					}
					timer.current = null;
				}, intervalMs - elapsed);
			}
		}

		return () => {
			if (timer.current) {
				clearTimeout(timer.current);
				timer.current = null;
			}
			pending.current = null;
		};
	}, [value, intervalMs, isStreaming]);

	return throttled;
}
