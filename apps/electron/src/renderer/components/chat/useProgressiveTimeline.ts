import { useEffect, useRef, useState } from "react";

export const CHUNK_SIZE = 6;

/**
 * 尾部优先的渐进渲染：首次只提交最新窗口，旧消息从上方逐帧补入，
 * 避免 Markdown/Shiki/Mermaid 挡住用户看到刚生成的对话。
 */
export function useProgressiveTimeline(
	timelineLength: number,
	historyKey: string,
): {
	renderCount: number;
	isProgressive: boolean;
} {
	const [renderCount, setRenderCount] = useState(CHUNK_SIZE);
	const [chunking, setChunking] = useState(false);
	const lastTimelineLengthRef = useRef(0);
	const historyKeyRef = useRef<string | null>(null);

	useEffect(() => {
		const previousHistoryKey = historyKeyRef.current;
		const historyChanged = previousHistoryKey !== null && previousHistoryKey !== historyKey;
		historyKeyRef.current = historyKey;

		const previousLength = lastTimelineLengthRef.current;
		const currentLength = timelineLength;
		lastTimelineLengthRef.current = currentLength;

		if (historyChanged) {
			setChunking(currentLength > CHUNK_SIZE);
			setRenderCount(Math.min(currentLength, CHUNK_SIZE * 2));
			return;
		}
		if (currentLength <= CHUNK_SIZE) {
			setChunking(false);
			setRenderCount(currentLength);
			return;
		}
		if (previousLength === 0) {
			setChunking(true);
			setRenderCount(CHUNK_SIZE);
			return;
		}
		if (!chunking && currentLength - previousLength > CHUNK_SIZE) {
			setChunking(true);
			setRenderCount((count) => Math.min(currentLength, Math.max(count, previousLength + CHUNK_SIZE)));
			return;
		}
		if (!chunking) {
			if (renderCount !== currentLength) setRenderCount(currentLength);
			return;
		}
		if (renderCount >= currentLength) {
			setChunking(false);
			setRenderCount(currentLength);
			return;
		}

		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		const advance = () => {
			if (settled) return;
			settled = true;
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			setRenderCount((count) => Math.min(currentLength, count + CHUNK_SIZE));
		};
		const frameId = requestAnimationFrame(advance);
		timeoutId = setTimeout(advance, 120);
		return () => {
			settled = true;
			cancelAnimationFrame(frameId);
			if (timeoutId !== undefined) clearTimeout(timeoutId);
		};
	}, [chunking, historyKey, renderCount, timelineLength]);

	const isProgressive = timelineLength > CHUNK_SIZE && renderCount < timelineLength;
	return { renderCount, isProgressive };
}
