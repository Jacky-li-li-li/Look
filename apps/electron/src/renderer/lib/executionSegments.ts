// ============================================================
// executionSegments — 消息块分段（纯函数）
//
// 将 assistant 消息的内容块切成渲染段：
//   - group:    连续的非 subagent thinking/toolCall（折叠执行组）
//   - subagent: 连续的 subagent 类工具调用（独立卡片区，默认展开）
//   - single:   其余块（文本/图片等）
//
// subagent 类调用在分段层剔出后，group 徽标的「N 个工具调用」
// 计数自然不含它们；顺序严格保持。
// ============================================================

export type ExecutionSegment<B> =
	| { kind: "single"; block: B; index: number }
	| { kind: "group"; blocks: B[]; startIndex: number }
	| { kind: "subagent"; blocks: B[]; startIndex: number };

/**
 * @param isExecBlock     thinking 或 toolCall 块（可入执行组）
 * @param isSubagentCall  subagent 类工具调用块（isExecBlock 的子集）
 */
export function segmentExecutionBlocks<B>(
	blocks: B[],
	isExecBlock: (b: B) => boolean,
	isSubagentCall: (b: B) => boolean,
): ExecutionSegment<B>[] {
	const segments: ExecutionSegment<B>[] = [];
	let i = 0;
	while (i < blocks.length) {
		const b = blocks[i];
		if (isSubagentCall(b)) {
			const startIndex = i;
			const run: B[] = [];
			while (i < blocks.length && isSubagentCall(blocks[i])) {
				run.push(blocks[i]);
				i++;
			}
			segments.push({ kind: "subagent", blocks: run, startIndex });
		} else if (isExecBlock(b)) {
			const startIndex = i;
			const run: B[] = [];
			while (i < blocks.length && isExecBlock(blocks[i]) && !isSubagentCall(blocks[i])) {
				run.push(blocks[i]);
				i++;
			}
			segments.push({ kind: "group", blocks: run, startIndex });
		} else {
			segments.push({ kind: "single", block: b, index: i });
			i++;
		}
	}
	return segments;
}
