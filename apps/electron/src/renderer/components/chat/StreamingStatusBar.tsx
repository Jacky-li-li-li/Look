// ============================================================
// StreamingStatusBar — 流式阶段状态行（ThinkingOrb 动画 + 状态文字 + 计时）
//
// 阶段判定与展示分离：
//   - streamingPhase() 纯函数按流式块判定当前阶段（thinking / tool / text）
//   - ThinkingOrb 渲染 connecting（web 网络）动画，颜色跟随 LOOK 主题；
//     web 模式的"信号脉冲"是离散跳变（哈希 epoch 换目标节点），64 预设 ×3x
//     时每秒约 21 次跳变（实测），在 20px 下表现为明显的跳动 —— 改用与显示
//     尺寸一致的 20 预设（count 缩放：1 信号 / 8 节点）+ 0.5x 速度，跳变降至
//     约 1 次/秒，旋转/摆动/脉冲保持平滑可见
//   - 计时从组件挂载（即 streaming 开始）起；仅在秒数变化时 setState
//     （React 对相同值 bail-out），其余 900ms/秒 组件完全静止，不再每 100ms
//     强制重渲染
//   - 阶段文字 min-w-[10em]：三语最大文案内切换不推挤计时器，消除横向跳动
// ============================================================

import type { LookUiStreamBlock, LookUiToolExecState } from "@shared/types";
import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLookTheme } from "../../hooks/useLookTheme";
import { LookThinkingOrb } from "./LookThinkingOrb";

export type StreamingPhase = "thinking" | "tool" | "text";

/**
 * 根据流式块 + 工具执行状态判定当前阶段；非流式返回 null。
 *
 * 工具阶段必须同时看两处：
 *   - toolcall 块未完成：模型正在生成调用参数（短窗口）
 *   - toolExecutions 有 running 项：工具真正在执行 —— 这是整个回合最耗时的
 *     阶段；toolcall_end 后块已 completed，此前会被误判为 thinking，
 *     状态行全程卡在"正在思考"（实测复现）。
 */
export function streamingPhase(
	blocks: LookUiStreamBlock[],
	toolExecutions: Record<string, LookUiToolExecState>,
	isStreaming: boolean,
): StreamingPhase | null {
	if (!isStreaming) return null;
	if (blocks.length === 0) return "thinking";
	if (
		blocks.some((b) => b.kind === "toolcall" && !b.completed) ||
		Object.values(toolExecutions).some((t) => t.phase === "running")
	) {
		return "tool";
	}
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
			{/* 20 预设与显示尺寸一致（count 调校：1 信号 / 8 节点，而非把 64 预设
			   的 5 信号缩放进 20px）。speed 0.5 使 web 模式的信号跳变 ~21 次/秒
			   降至 ~1 次/秒，消除跳动；LookThinkingOrb 为自驱动封装（无
			   IntersectionObserver 离屏暂停），流式期间始终动画。 */}
			<LookThinkingOrb state="connecting" size={20} speed={0.5} dark={tone === "dark"} />
			{/* 阶段文字按自然宽度布局（不设 min-w 占位）：短文案（en/zh）时
			   计时器紧跟文本（flex gap-2），避免文本与计时器之间出现大段空隙；
			   三语切换时计时器随文本宽度顺滑移动。 */}
			<span className="whitespace-nowrap text-xs font-normal">{t(PHASE_LABEL_KEY[phase])}</span>
			<span className="font-mono text-[10px] tabular-nums opacity-70">{formatElapsed(elapsed)}</span>
		</div>
	);
});
