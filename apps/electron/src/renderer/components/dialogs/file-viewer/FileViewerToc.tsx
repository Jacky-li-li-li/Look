// ============================================================
// FileViewerToc — Markdown 目录导航
//
// 从原文提取标题大纲（≥2 个标题时显示），左侧导航栏：
//   - 点击标题滚动定位（重复标题按出现序号挑选）
//   - 滚动时高亮当前标题（顶部 30% 线上方最后一个；滚到底锁定最后一个）
//   - 目录栏宽度可拖拽（140–360px）
//   - 折叠/展开（跨文件保持）
//
// 拆出自 FileViewerDialog：TOC 是自足的展示关注点，且 scroll 高亮逻辑
// （rAF 节流 + 30% 线）可被独立维护。
// ============================================================

import { cn } from "@look/ui";
import { Button } from "@look/ui/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@look/ui/components/ui/tooltip";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TocHeading } from "../../../lib/markdownToc";

interface FileViewerTocProps {
	headings: TocHeading[];
	/** 渲染 markdown 的容器（标题元素挂载其内，带 data-toc-slug）。 */
	previewRef: React.RefObject<HTMLDivElement | null>;
	/** 折叠态切换回调（父组件用折叠态决定是否渲染本组件）。 */
	onCollapse: () => void;
	/** 宽度由父组件持有：本组件在折叠/切换非 Markdown 文件时会卸载，本地态会丢宽度。 */
	width: number;
	onWidthChange: (width: number) => void;
}

export function FileViewerToc({ headings, previewRef, onCollapse, width, onWidthChange }: FileViewerTocProps) {
	const { t } = useTranslation();
	const [activeSlug, setActiveSlug] = useState<string | null>(null);
	const minTocLevel = Math.min(...headings.map((h) => h.level), 6);

	// 目录定位：重复标题共享同一 data-toc-slug，用出现序号挑选目标
	const findHeadingElement = useCallback(
		(heading: TocHeading): HTMLElement | null => {
			const container = previewRef.current;
			if (!container) return null;
			const matches = container.querySelectorAll(`[data-toc-slug="${CSS.escape(heading.baseSlug)}"]`);
			const target = matches.item(heading.occurrence);
			return target instanceof HTMLElement ? target : null;
		},
		[previewRef],
	);

	const scrollToHeading = useCallback(
		(heading: TocHeading) => {
			const target = findHeadingElement(heading);
			if (!target) return;
			const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
			target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
			setActiveSlug(heading.slug);
		},
		[findHeadingElement],
	);

	// 滚动高亮：LookMarkdown 懒加载，延迟建立 scroll 监听；rAF 节流。
	useEffect(() => {
		let cleanup: (() => void) | undefined;
		let raf = 0;
		const timer = setTimeout(() => {
			const container = previewRef.current;
			if (!container) return;
			const entries = headings
				.map((h) => ({ slug: h.slug, el: findHeadingElement(h) }))
				.filter((entry): entry is { slug: string; el: HTMLElement } => entry.el instanceof HTMLElement);
			if (entries.length === 0) return;
			const update = () => {
				const zoneTop = container.getBoundingClientRect().top + container.clientHeight * 0.3;
				let currentIndex = 0;
				for (let i = 0; i < entries.length; i += 1) {
					if (entries[i].el.getBoundingClientRect().top <= zoneTop) currentIndex = i;
					else break;
				}
				if (container.scrollTop + container.clientHeight >= container.scrollHeight - 4) {
					currentIndex = entries.length - 1;
				}
				setActiveSlug(entries[currentIndex].slug);
			};
			const onScroll = () => {
				cancelAnimationFrame(raf);
				raf = requestAnimationFrame(update);
			};
			container.addEventListener("scroll", onScroll, { passive: true });
			update();
			cleanup = () => container.removeEventListener("scroll", onScroll);
		}, 250);
		return () => {
			clearTimeout(timer);
			cancelAnimationFrame(raf);
			cleanup?.();
		};
	}, [headings, findHeadingElement, previewRef]);

	const handleTocResizeStart = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			event.preventDefault();
			const startX = event.clientX;
			const startWidth = width;
			const onMove = (ev: PointerEvent) => {
				const next = Math.min(360, Math.max(140, startWidth + ev.clientX - startX));
				onWidthChange(next);
			};
			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
			};
			document.body.style.cursor = "col-resize";
			document.body.style.userSelect = "none";
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[width, onWidthChange],
	);

	return (
		<>
			<nav
				className="shrink-0 overflow-y-auto py-3 pl-3 pr-1"
				style={{ width }}
				aria-label={t("fileViewer.contents")}
			>
				<div className="flex items-center justify-between px-2 pb-2">
					<p className="text-[11px] font-medium text-muted-foreground">{t("fileViewer.contents")}</p>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon-xs"
								onClick={onCollapse}
								aria-label={t("fileViewer.collapseContents")}
							>
								<PanelLeftClose className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">{t("fileViewer.collapseContents")}</TooltipContent>
					</Tooltip>
				</div>
				<ul className="space-y-0.5">
					{headings.map((h) => (
						<li key={h.slug}>
							<button
								type="button"
								onClick={() => scrollToHeading(h)}
								className={cn(
									"block w-full truncate rounded px-2 py-1 text-left text-xs transition-colors",
									activeSlug === h.slug
										? "bg-muted font-medium text-foreground shadow-[inset_2px_0_0_0_var(--primary)]"
										: "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
								)}
								style={{ paddingLeft: `${(h.level - minTocLevel) * 12 + 8}px` }}
								title={h.text}
							>
								{h.text}
							</button>
						</li>
					))}
				</ul>
			</nav>
			{/* 拖拽调宽把手：1px 分隔线，4px 命中区，hover/拖拽时变亮 */}
			<div
				className="group flex w-1 shrink-0 cursor-col-resize touch-none items-stretch justify-center"
				onPointerDown={handleTocResizeStart}
				role="separator"
				aria-orientation="vertical"
			>
				<div className="w-px bg-border transition-colors group-hover:bg-foreground/30 group-active:bg-foreground/50" />
			</div>
		</>
	);
}

/** 折叠态展开按钮（渲染在正文顶部工具条）。 */
export function FileViewerTocExpandButton({ onExpand }: { onExpand: () => void }) {
	const { t } = useTranslation();
	return (
		<div className="flex shrink-0 items-center border-b px-2 py-1">
			<Tooltip>
				<TooltipTrigger asChild>
					<Button variant="ghost" size="sm" onClick={onExpand} aria-label={t("fileViewer.expandContents")}>
						<PanelLeftOpen className="size-3.5" />
						<span className="text-xs">{t("fileViewer.contents")}</span>
					</Button>
				</TooltipTrigger>
				<TooltipContent side="bottom">{t("fileViewer.expandContents")}</TooltipContent>
			</Tooltip>
		</div>
	);
}
