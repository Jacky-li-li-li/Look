// ============================================================
// ChatQueueDrawer — 排队消息指示器
//
// 位于聊天区和输入框之间，显示等待顺序交付的 steer / followUp 消息。
// steer = 引导修正（工作中 Enter），followUp = 追加任务（Shift+Enter）。
// 视觉隐喻："热介入 / 冷排队" — steer 用左侧暖色条，followUp 用冷灰条。
// ============================================================

import { cn } from "@shared/lib/utils";
import { memo } from "react";
import { useTranslation } from "react-i18next";

interface QueueEntry {
	text: string;
	kind: "steer" | "followUp";
	index: number;
}

interface ChatQueueDrawerProps {
	steerMessages: readonly string[];
	followUpMessages: readonly string[];
}

const ChatQueueDrawer = memo(function ChatQueueDrawer({ steerMessages, followUpMessages }: ChatQueueDrawerProps) {
	const { t } = useTranslation();
	const total = steerMessages.length + followUpMessages.length;

	if (total === 0) return null;

	// 构建有序列表：steer 在前，followUp 在后，各自保持原始序号
	const entries: QueueEntry[] = [
		...steerMessages.map((text, i) => ({ text, kind: "steer" as const, index: i })),
		...followUpMessages.map((text, i) => ({ text, kind: "followUp" as const, index: i })),
	];

	return (
		<div className="shrink-0 mx-5 rounded-lg border border-hairline bg-card/30 backdrop-blur-sm">
			{/* 消息行 */}
			<div className="divide-y divide-hairline/50">
				{entries.map((entry, i) => (
					<div
						key={`${entry.kind}-${entry.index}`}
						className={cn(
							"group flex items-center gap-2.5 px-4 py-2 transition-colors hover:bg-card/40",
							entry.kind === "steer"
								? "border-l-2 border-l-primary/40"
								: "border-l-2 border-l-muted-foreground/25",
						)}
					>
						{/* 序号 */}
						<span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/40 min-w-[1.25em] text-right">
							{i + 1}
						</span>
						{/* 类型标签 */}
						<span
							className={cn(
								"shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium leading-none",
								entry.kind === "steer" ? "bg-primary/10 text-primary/70" : "bg-muted text-muted-foreground/60",
							)}
						>
							{entry.kind === "steer" ? t("chat.queuedSteering") : t("chat.queuedFollowUp")}
						</span>
						{/* 消息文本 */}
						<span className="min-w-0 truncate text-[12px] leading-relaxed text-foreground/70">{entry.text}</span>
					</div>
				))}
			</div>

			{/* 底部操作栏 */}
			<div className="flex items-center justify-between px-4 py-1.5">
				<span className="text-[10px] tabular-nums text-muted-foreground/50">
					{total} {t("chat.queuedCount")}
				</span>
			</div>
		</div>
	);
});

export default ChatQueueDrawer;
