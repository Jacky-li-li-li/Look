// ============================================================
// StreamingStatusBar — 流式阶段状态行（九宫格顺时针 + 状态文字 + 计时）
//
// 阶段判定与展示分离：
//   - streamingPhase() 纯函数按流式块判定当前阶段（thinking / tool / text）
//   - CubeLoader 渲染 3×3 九宫格，外圈按顺时针顺序点亮（区别于波浪式）
//   - 计时从组件挂载（即 streaming 开始）起，每 100ms 刷新一次
// 样式在 App.css 的 look-cube-loader* 段。
// ============================================================

import { cn } from "@look/ui";
import type { LookUiStreamBlock } from "@shared/types";
import { memo, useEffect, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";

export type StreamingPhase = "thinking" | "tool" | "text";

/** 根据流式块判定当前阶段；非流式返回 null。 */
export function streamingPhase(blocks: LookUiStreamBlock[], isStreaming: boolean): StreamingPhase | null {
	if (!isStreaming) return null;
	if (blocks.length === 0) return "thinking";
	// 有未完成的工具调用 → 工具阶段（优先于思考：工具执行期间 thinking 通常已结束）
	if (blocks.some((b) => b.kind === "toolcall" && !b.completed)) return "tool";
	// 有未完成的思考 → 思考阶段
	if (blocks.some((b) => b.kind === "thinking" && !b.completed)) return "thinking";
	// 有已输出/进行中的正文 → 输出阶段
	if (blocks.some((b) => b.kind === "text" && (b.text || !b.completed))) return "text";
	return "thinking";
}

/**
 * 9 格（行优先 0..8）中外圈按顺时针扫描的位置顺序：
 * 0 1 2
 * 7 8 3
 * 6 5 4
 * 中心格（4）不参与扫描，保持常亮作为视觉锚点。
 */
const CLOCKWISE_POSITIONS = [0, 1, 2, 5, 8, 7, 6, 3];

/** 3×3 九宫格，外圈方块按顺时针顺序依次点亮。 */
export const CubeLoader = memo(function CubeLoader({ className }: { className?: string }) {
	return (
		<span className={cn("look-cube-loader", className)} aria-hidden="true">
			{Array.from({ length: 9 }, (_, i) => {
				const order = CLOCKWISE_POSITIONS.indexOf(i);
				const isActive = order >= 0;
				return (
					<span
						key={i}
						className={cn(
							"look-cube-loader__cube",
							isActive && "look-cube-loader__cube--active",
							i === 4 && "look-cube-loader__cube--center",
						)}
						style={isActive ? { animationDelay: `${order * 0.15}s` } : undefined}
					/>
				);
			})}
		</span>
	);
});

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}m ${s}s`;
}

const PHASE_LABEL_KEY: Record<StreamingPhase, string> = {
	thinking: "chat.streamingThinking",
	tool: "chat.streamingTool",
	text: "chat.streamingText",
};

/** 流式阶段状态行：九宫格 + 状态文字 + 已等待秒数。 */
export const StreamingStatusBar = memo(function StreamingStatusBar({ phase }: { phase: StreamingPhase }) {
	const { t } = useTranslation();
	const [startedAt] = useState(() => Date.now());
	const [, forceRender] = useReducer((x: number) => x + 1, 0);

	useEffect(() => {
		const id = window.setInterval(() => forceRender(), 100);
		return () => window.clearInterval(id);
	}, []);

	const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));

	return (
		<div className="flex items-center gap-2 py-1 text-sm text-muted-foreground" role="status">
			<CubeLoader />
			<span className="text-xs font-normal">{t(PHASE_LABEL_KEY[phase])}</span>
			<span className="font-mono text-[10px] tabular-nums opacity-70">{formatElapsed(elapsed)}</span>
		</div>
	);
});
