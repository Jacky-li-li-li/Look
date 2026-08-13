// ============================================================
// ThinkingPanel — 思考过程内容块（Ink Wash, shadcn/ui）
//
// 始终展示、带外虚线边框的内容块（标题行 + 字符数 + 正文）。
// 内容超过折叠高度（96px）时自动截断，底部以渐隐 + 虚化（渐变
// 遮罩 + backdrop blur）过渡，并提供「展开全部 / 收起」交互；
// 流式期间自动展开实时跟随输出，输出结束后恢复超高折叠。
// 流式增量片段以 reveal 动画淡入，避免整块跳变。
// ============================================================

import { cn } from "@look/ui";
import { Brain, ChevronDown } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { useConversationContextSafe } from "./conversation";

/** 折叠态正文最大高度（px）；对应样式类 max-h-24。 */
const COLLAPSED_BODY_HEIGHT = 96;

interface ThinkingPanelProps {
	thinking: string;
	isStreaming: boolean;
}

const ThinkingPanel = React.memo(function ThinkingPanel({ thinking, isStreaming }: ThinkingPanelProps) {
	const { t } = useTranslation();
	// 展开时脱离“贴底”锁定：防止 stick-to-bottom 的 resize 跟随把视口拽到
	// 展开后内容的底部（与 CollapsibleExecutionGroup 同一问题的 thinking 版本）。
	const ctx = useConversationContextSafe();
	const [expanded, setExpanded] = React.useState(() => isStreaming);
	const [overflows, setOverflows] = React.useState(false);
	const bodyRef = React.useRef<HTMLDivElement>(null);

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

	// 流式期间自动展开（实时跟随输出）；输出结束后自动折叠（超高时截断）。
	React.useEffect(() => {
		setExpanded(isStreaming);
	}, [isStreaming]);

	// 测量内容是否超出折叠高度：展开态比对内容总高度与折叠阈值；折叠态直接
	// 比对 scrollHeight / clientHeight（max-h 截断后两者的差值即溢出量）。
	// 内容增长由 ResizeObserver 触发重测（无 RO 环境挂载时测一次，足够静态内容使用）。
	React.useEffect(() => {
		const el = bodyRef.current;
		if (!el) return;
		const update = () => {
			setOverflows(expanded ? el.scrollHeight > COLLAPSED_BODY_HEIGHT : el.scrollHeight > el.clientHeight);
		};
		update();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
	}, [expanded]);

	const handleToggle = React.useCallback(() => {
		if (!expanded) {
			ctx?.stopScroll();
		}
		setExpanded((prev) => !prev);
	}, [expanded, ctx]);

	// 流式但思考内容尚未到达：显示带脉冲指示的占位行（同样的虚线边框，
	// 保持“思考内容块”的视觉一致性）。
	if (!thinking) {
		if (!isStreaming) return null;
		return (
			<div
				data-thinking-panel=""
				className="flex items-center gap-1.5 rounded-md border border-dashed border-hairline px-2.5 py-1 text-[11px] text-muted-foreground"
			>
				<Brain className="size-3.5 shrink-0 text-blue-400 dark:text-blue-300" />
				<span className="min-w-0 flex-1 truncate text-left font-medium text-foreground">{t("chat.reasoning")}</span>
				<span className="inline-block w-2 h-4 bg-blue-400 animate-pulse rounded-xs" />
			</div>
		);
	}

	return (
		<div data-thinking-panel="" className="overflow-hidden rounded-md border border-dashed border-hairline">
			<div className="flex items-center gap-1.5 border-b border-hairline px-2.5 py-1 text-[11px] text-muted-foreground">
				<Brain className="size-3.5 shrink-0 text-blue-400 dark:text-blue-300" />
				<span className="min-w-0 flex-1 truncate text-left font-medium text-foreground">{t("chat.reasoning")}</span>
				<span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
					{t("chat.characters", { count: thinking.length.toLocaleString() })}
				</span>
			</div>
			<div
				ref={bodyRef}
				data-thinking-panel-body=""
				data-expanded={expanded}
				className={cn(
					"relative overflow-hidden px-2.5 py-1.5 text-[11px] leading-[1.4] text-muted-foreground",
					!expanded && "max-h-24",
				)}
			>
				<div className="whitespace-pre-wrap break-words">
					{stableText}
					{deltaText.length > 0 && (
						<span key={stableLen} className="look-thinking-reveal">
							{deltaText}
						</span>
					)}
				</div>
				{!expanded && overflows && (
					<div
						aria-hidden="true"
						data-thinking-fade=""
						className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent backdrop-blur-[2px]"
						style={{
							WebkitMaskImage: "linear-gradient(to bottom, transparent, black 75%)",
							maskImage: "linear-gradient(to bottom, transparent, black 75%)",
						}}
					/>
				)}
			</div>
			{overflows && (
				<button
					type="button"
					data-thinking-expand-toggle=""
					aria-expanded={expanded}
					onClick={handleToggle}
					className="flex w-full items-center justify-center gap-1 px-2 pb-1.5 pt-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
				>
					<ChevronDown className={cn("size-3 transition-transform duration-150", expanded && "rotate-180")} />
					{expanded ? t("chat.reasoningCollapse") : t("chat.reasoningExpand")}
				</button>
			)}
		</div>
	);
});

export default ThinkingPanel;
