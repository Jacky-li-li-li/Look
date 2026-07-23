// ============================================================
// Task notification builder — Feishu card formatting
//
// Extracted from index.ts. Converts scheduled task execution results
// into formatted text and Feishu interactive card payloads.
// ============================================================

/**
 * Build a Feishu-compatible notification for a completed scheduled task.
 * Returns plain text (for IM message fallback) and a card (for rich display).
 */
export function buildTaskFinishedNotification(
	taskName: string,
	succeeded: boolean,
	finishedAt: string,
	model: string | undefined,
	rawDetail: string,
): { text: string; card: Record<string, unknown> } {
	const text = [
		`${succeeded ? "✅" : "❌"} 定时任务「${taskName}」${succeeded ? "执行成功" : "执行失败"}`,
		`时间：${finishedAt}`,
		model ? `模型：${model}` : undefined,
		rawDetail ? `结果：${rawDetail.slice(0, 1_500)}` : undefined,
	]
		.filter(Boolean)
		.join("\n");

	// 先截断再转义：避免转义膨胀（*→\*）导致有效内容被额外压缩
	const MAX_RESULT = 20_000;
	const snippet = rawDetail.length > MAX_RESULT ? `${rawDetail.slice(0, MAX_RESULT)}…[内容过长已截断]` : rawDetail;
	const escaped = snippet.replace(/\*/g, "\\*").replace(/_/g, "\\_").replace(/`/g, "\\`");
	const resultContent = rawDetail
		? `**执行结果：**\n${escaped}`
		: succeeded
			? "**执行结果：** （无输出内容）"
			: "**执行结果：** （无错误信息）";

	const card = {
		config: { wide_screen_mode: true },
		header: {
			title: {
				tag: "plain_text" as const,
				content: `${succeeded ? "✅" : "❌"} 定时任务「${taskName}」${succeeded ? "执行成功" : "执行失败"}`,
			},
			template: succeeded ? ("green" as const) : ("red" as const),
		},
		elements: [
			{ tag: "markdown" as const, content: `**任务状态：** ${succeeded ? "成功" : "失败"}` },
			{ tag: "markdown" as const, content: `**执行时间：** ${finishedAt}` },
			...(model ? [{ tag: "markdown" as const, content: `**执行模型：** ${model}` }] : []),
			{ tag: "markdown" as const, content: resultContent },
		],
	};

	return { text, card };
}
