// ============================================================
// ChatQueueDrawer — Queue preview drawer (Ink Wash)
// Slides up when the SDK's queue is non-empty. Pure display.
// ============================================================

import { cn } from "@shared/lib/utils";
import { memo } from "react";
import { useTranslation } from "react-i18next";

interface ChatQueueDrawerProps {
	queue: { steering: string[]; followUp: string[] };
}

const ChatQueueDrawer = memo(function ChatQueueDrawer({ queue }: ChatQueueDrawerProps) {
	const { t } = useTranslation();

	return (
		<div
			className={cn(
				"shrink-0 overflow-hidden transition-all duration-200 ease-out",
				queue.steering.length + queue.followUp.length > 0 ? "max-h-56 opacity-100" : "max-h-0 opacity-0",
			)}
		>
			<div className="w-full px-5 py-2">
				<div className="mb-1.5 flex items-center gap-2">
					<span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
						{t("chat.queued")}
					</span>
					<span className="text-[10px] tabular-nums text-muted-foreground/40">
						{queue.steering.length + queue.followUp.length}
					</span>
				</div>
				<div className="max-h-40 space-y-1 overflow-y-auto">
					{[...queue.steering, ...queue.followUp].map((text, i) => (
						<div
							key={`q-${text.slice(0, 32)}`}
							className="flex items-center gap-2 rounded-md border border-hairline bg-card/40 px-2.5 py-1.5 animate-draw-in"
							style={{ animationDelay: `${i * 40}ms` }}
						>
							<span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold tabular-nums text-muted-foreground">
								{i + 1}
							</span>
							<span className="min-w-0 truncate text-[12px] leading-relaxed text-foreground/70">{text}</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
});

export default ChatQueueDrawer;
