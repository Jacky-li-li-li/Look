// ============================================================
// StreamingStatusBar — 流式阶段状态行（ThinkingOrb 动画 + 状态文字 + 计时）
//
// 阶段判定与展示分离：
//   - streamingPhase() 纯函数按流式块判定当前阶段（thinking / tool / text）
//   - ThinkingOrb 渲染 connecting 动画（64px，3.00x），颜色跟随 LOOK 主题
//   - 计时从组件挂载（即 streaming 开始）起；仅在秒数变化时 setState
//     （React 对相同值 bail-out），其余 900ms/秒 组件完全静止，不再每 100ms
//     强制重渲染
//   - 阶段文字 min-w-[9em]：三语最大文案内切换不推挤计时器，消除横向跳动
// ============================================================

import type { LookUiStreamBlock } from "@shared/types";
import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLookTheme } from "../../hooks/useLookTheme";
import { LookThinkingOrb } from "./LookThinkingOrb";

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

/** 流式阶段状态行：ThinkingOrb + 状态文字 + 已等待秒数。 */
export const StreamingStatusBar = memo(function StreamingStatusBar({ phase }: { phase: StreamingPhase }) {
	const { t } = useTranslation();
	const { tone } = useLookTheme();
	const [startedAt] = useState(() => Date.now());
	const [elapsed, setElapsed] = useState(0);

	useEffect(() => {
		const id = window.setInterval(() => {
			const next = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
			// 只在秒数变化时更新：setState 相同值 React 自动 bail-out，
			// 避免无谓重渲染。250ms 间隔对秒级显示足够（切换后 ≤250ms 刷新）。
			setElapsed((prev) => (prev === next ? prev : next));
		}, 250);
		return () => window.clearInterval(id);
	}, [startedAt]);

	return (
		<div className="flex items-center gap-2 py-1 text-sm text-muted-foreground" role="status">
			{/* thinking-orbs 仅提供 64/20 两个预置：保持 64 预设绘制，CSS 显示为一半（32px）。
			   LookThinkingOrb 为自驱动封装（无 IntersectionObserver 离屏暂停），流式期间始终动画。 */}
			<LookThinkingOrb state="connecting" size={64} speed={3} dark={tone === "dark"} displaySize={20} />
			{/* min-w-[10em]：大于三语最大文案（日文「ツール呼び出し中…」≈9em），
			   阶段切换不改变占位宽度，计时器不被左右推挤。 */}
			<span className="min-w-[10em] whitespace-nowrap text-xs font-normal">{t(PHASE_LABEL_KEY[phase])}</span>
			<span className="font-mono text-[10px] tabular-nums opacity-70">{formatElapsed(elapsed)}</span>
		</div>
	);
});
