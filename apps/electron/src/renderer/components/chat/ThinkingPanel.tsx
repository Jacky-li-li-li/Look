// ============================================================
// ThinkingPanel — Inset Drawer (Ink Wash, shadcn/ui)
// Collapsed by default (same as single tool-call cards), unless
// the autoCollapse setting is off. User manual toggle overrides
// the default for the lifetime of this panel.
//
// NOTE: Uses pure CSS collapse instead of Radix Collapsible to
// avoid expensive hook overhead (Presence/useLayoutEffect) during
// agent switches where many panels mount simultaneously.
// ============================================================

import { cn } from "@look/ui";
import { Brain, ChevronRight } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { useConversationContextSafe } from "./conversation";

interface ThinkingPanelProps {
	thinking: string;
	isStreaming: boolean;
	autoCollapse: boolean;
}

const ThinkingPanel = React.memo(function ThinkingPanel({ thinking, isStreaming, autoCollapse }: ThinkingPanelProps) {
	const { t } = useTranslation();
	// 仅在处于 Conversation（StickToBottom）内时可用；独立渲染（测试等）时优雅降级
	const ctx = useConversationContextSafe();
	// Collapsed by default (like tool-call cards); a boolean manualOpen
	// means the user has taken control, null means "follow autoCollapse".
	const [manualOpen, setManualOpen] = React.useState<boolean | null>(null);
	const [hasRenderedBody, setHasRenderedBody] = React.useState(() => !autoCollapse);
	const open = manualOpen ?? !autoCollapse;

	// ── 流式增量渲染 ──
	// thinking 是每批 delta 后的累计全文；把「本批新增片段」单独包一层 reveal span
	// （淡入 + 轻微下落），避免整块直接替换造成的“一蹦一蹦”跳变感。
	// prevLenRef 在 effect 中提交（不在 render 内推进，兼容 StrictMode 双调用）。
	const prevLenRef = React.useRef(0);
	const thinkingLen = thinking.length;
	const growing = isStreaming && thinkingLen >= prevLenRef.current;
	const stableLen = growing ? prevLenRef.current : thinkingLen;
	const stableText = thinking.slice(0, stableLen);
	const deltaText = growing ? thinking.slice(stableLen) : "";

	React.useEffect(() => {
		prevLenRef.current = thinkingLen;
	});

	const handleToggle = React.useCallback(() => {
		// 展开时脱离“贴底”锁定：防止 stick-to-bottom 的 resize 跟随把视口拽到
		// 展开后内容的底部（与 CollapsibleExecutionGroup 同一问题的 thinking 版本）。
		if (!open) {
			ctx?.stopScroll();
			setHasRenderedBody(true);
		}
		setManualOpen((prev) => !(prev ?? !autoCollapse));
	}, [autoCollapse, open, ctx]);

	// When streaming but no thinking content has arrived yet, show a loading
	// skeleton with a pulse indicator so the user knows reasoning is in progress.
	if (!thinking) {
		if (!isStreaming) return null;
		return (
			<div
				data-thinking-panel=""
				className="flex cursor-default items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground"
			>
				<ChevronRight className="size-3 shrink-0" />
				<Brain className="size-3.5 shrink-0 text-blue-400 dark:text-blue-300" />
				<span className="min-w-0 flex-1 truncate text-left font-medium text-foreground">{t("chat.reasoning")}</span>
				<span className="inline-block w-2 h-4 bg-blue-400 animate-pulse rounded-xs" />
			</div>
		);
	}

	return (
		<div data-thinking-panel="">
			<button
				type="button"
				className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:bg-muted/50 focus-visible:text-foreground"
				aria-expanded={open}
				onClick={handleToggle}
			>
				<ChevronRight className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")} />
				<Brain className="size-3.5 shrink-0 text-blue-400 dark:text-blue-300" />
				<span className="min-w-0 flex-1 truncate text-left font-medium text-foreground">{t("chat.reasoning")}</span>
				<span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
					{t("chat.characters", { count: thinking.length.toLocaleString() })}
				</span>
			</button>
			<div
				data-tool-panel-body=""
				data-open={open}
				className={cn("grid", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
				style={{
					transition: "grid-template-rows 380ms cubic-bezier(0.0, 0.0, 0.2, 1), opacity 320ms ease",
				}}
			>
				<div className="overflow-hidden">
					{hasRenderedBody || open ? (
						<div className="max-h-72 overflow-auto px-2.5 py-1.5 text-[11px] leading-[1.4] text-muted-foreground">
							<div className="whitespace-pre-wrap break-words">
								{stableText}
								{deltaText.length > 0 && (
									<span key={stableLen} className="look-thinking-reveal">
										{deltaText}
									</span>
								)}
							</div>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
});

export default ThinkingPanel;
