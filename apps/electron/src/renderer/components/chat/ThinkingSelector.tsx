// ============================================================
// ThinkingSelector — Detent Slider Popover (Ink Wash, no Radix)
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import SimplePopover from "@look/ui/components/ui/simple-popover";
import type { ThinkingLevel } from "@shared/types";
import type { TFunction } from "i18next";
import { Brain } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

function buildLevels(t: TFunction): { value: ThinkingLevel; label: string; desc: string }[] {
	return [
		{ value: "off", label: t("agent.thinkingOff", "Off"), desc: t("agent.thinkingOffDesc", "No extended thinking") },
		{
			value: "minimal",
			label: t("agent.thinkingMinimal", "Minimal"),
			desc: t("agent.thinkingMinimalDesc", "~1K tokens"),
		},
		{ value: "low", label: t("agent.thinkingLow", "Low"), desc: t("agent.thinkingLowDesc", "~4K tokens") },
		{
			value: "medium",
			label: t("agent.thinkingMedium", "Medium"),
			desc: t("agent.thinkingMediumDesc", "~10K tokens"),
		},
		{ value: "high", label: t("agent.thinkingHigh", "High"), desc: t("agent.thinkingHighDesc", "~32K tokens") },
		{
			value: "xhigh",
			label: t("agent.thinkingXHigh", "X-High"),
			desc: t("agent.thinkingXHighDesc", "Maximum reasoning"),
		},
		{
			value: "max",
			label: t("agent.thinkingMax", "Max"),
			desc: t("agent.thinkingMaxDesc", "Full reasoning"),
		},
	];
}

const LEVEL_COLORS: Record<ThinkingLevel, string> = {
	off: "text-muted-foreground",
	minimal: "text-blue-400 dark:text-blue-300",
	low: "text-blue-500 dark:text-blue-400",
	medium: "text-blue-600 dark:text-blue-400",
	high: "text-indigo-500 dark:text-indigo-400",
	xhigh: "text-indigo-600 dark:text-indigo-300",
	max: "text-purple-500 dark:text-purple-300",
};

interface ThinkingSelectorProps {
	currentLevel: string;
	availableThinkingLevels?: ThinkingLevel[];
	onChanged: (level: ThinkingLevel) => void;
}

interface SliderLevel {
	value: ThinkingLevel;
	label: string;
	desc: string;
}

/** 滑动阻块：拖动时拇指连续跟手、刻度与文案实时吸附最近档位；松手提交该档位 */
function ThinkingSlider({
	ariaLabel,
	levels,
	currentIndex,
	onSelect,
}: {
	ariaLabel: string;
	levels: SliderLevel[];
	currentIndex: number;
	onSelect: (index: number) => void;
}) {
	const count = levels.length;
	const trackRef = useRef<HTMLDivElement>(null);
	// 拖动期间为 0..1 连续位置；null 表示静止并吸附在档位刻度上。
	// 组件随弹窗面板挂载/卸载，状态不会跨开合残留。
	const [dragPos, setDragPos] = useState<number | null>(null);
	// 乐观档位：提交后 currentLevel 要等 IPC 事件回传才更新（可能数百毫秒），
	// 期间用本地值定位拇指，避免「先跳回旧档位再跳到新档位」的二次跳动。
	const [displayIndex, setDisplayIndex] = useState(currentIndex);
	useEffect(() => setDisplayIndex(currentIndex), [currentIndex]);

	const snapFraction = useCallback((i: number) => (count > 1 ? i / (count - 1) : 0), [count]);
	const liveIndex = Math.min(
		count - 1,
		Math.max(0, dragPos === null ? displayIndex : Math.round(dragPos * (count - 1))),
	);
	const live = levels[liveIndex] ?? levels[0];
	const thumbPos = dragPos ?? snapFraction(displayIndex);
	const grabOffsetRef = useRef(0);

	// clientX（已是拇指中心 x）→ 0..1 轨道比例
	const fractionFromCenterX = useCallback((centerX: number) => {
		const el = trackRef.current;
		if (!el) return 0;
		const rect = el.getBoundingClientRect();
		return Math.min(1, Math.max(0, (centerX - rect.left) / Math.max(rect.width, 1)));
	}, []);

	// 拇指半径（size-3.5 = 14px）+ 抓取容差
	const THUMB_GRAB_RADIUS = 12;

	const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (count < 2) return;
		e.preventDefault();
		const el = trackRef.current;
		if (!el) return;
		el.setPointerCapture(e.pointerId);
		// 从拇指上按下：记录指针相对拇指中心的偏移，拖动期间拇指锚定跟手，
		// 不瞬移到指针位置；点在轨道空白处：直接跳到该处（点击选档）。
		const rect = el.getBoundingClientRect();
		const thumbCenter = rect.left + thumbPos * rect.width;
		const onThumb = Math.abs(e.clientX - thumbCenter) <= THUMB_GRAB_RADIUS;
		grabOffsetRef.current = onThumb ? e.clientX - thumbCenter : 0;
		setDragPos(onThumb ? thumbPos : fractionFromCenterX(e.clientX));
	};

	const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (dragPos === null) return;
		setDragPos(fractionFromCenterX(e.clientX - grabOffsetRef.current));
	};

	const handlePointerEnd = () => {
		if (dragPos === null) return;
		const idx = Math.round(dragPos * (count - 1));
		setDragPos(null);
		setDisplayIndex(idx);
		if (idx !== currentIndex) onSelect(idx);
	};

	const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		if (count < 2) return;
		if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
			e.preventDefault();
			if (displayIndex > 0) {
				const next = displayIndex - 1;
				setDisplayIndex(next);
				onSelect(next);
			}
		} else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
			e.preventDefault();
			if (displayIndex < count - 1) {
				const next = displayIndex + 1;
				setDisplayIndex(next);
				onSelect(next);
			}
		}
	};

	return (
		<div className="flex flex-col gap-2.5">
			{/* 最近档位的实时读数：拖动时随吸附点切换 */}
			<div className="flex items-baseline justify-between gap-2 px-0.5">
				<span
					className={`flex items-center gap-1.5 text-[12px] font-medium transition-colors duration-150 ${LEVEL_COLORS[live.value]}`}
				>
					<span className="size-1.5 rounded-full bg-current" />
					{live.label}
				</span>
				<span className="text-[10px] text-muted-foreground">{live.desc}</span>
			</div>
			<div
				ref={trackRef}
				role="slider"
				tabIndex={0}
				aria-label={ariaLabel}
				aria-valuemin={1}
				aria-valuemax={count}
				aria-valuenow={liveIndex + 1}
				aria-valuetext={live.label}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerEnd}
				onPointerCancel={handlePointerEnd}
				onKeyDown={handleKeyDown}
				className="relative flex h-6 cursor-pointer touch-none items-center rounded-md outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/40"
			>
				{/* 轨道着色随当前档位：填充段 / 激活刻度 / 拇指统一取档位色。
					transition-colors 让跨越刻度时的档位色渐变而非硬切，消除闪烁 */}
				<div
					className={`relative h-1 w-full rounded-full transition-colors duration-200 ${LEVEL_COLORS[live.value]}`}
				>
					<div className="absolute inset-0 rounded-full bg-border" />
					<div
						className="absolute inset-y-0 left-0 rounded-full bg-current"
						style={{ width: `${(thumbPos * 100).toFixed(2)}%` }}
					/>
					{levels.map((l, i) => (
						<span
							key={l.value}
							className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-[height,width] duration-150 ${
								i === liveIndex ? "size-2 bg-current" : "size-1.5 bg-muted-foreground/70"
							}`}
							style={{ left: `${(snapFraction(i) * 100).toFixed(2)}%` }}
						/>
					))}
					<span
						className={`absolute top-1/2 z-10 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-popover bg-current shadow-sm ${
							dragPos === null ? "transition-[left] duration-150" : ""
						}`}
						style={{ left: `${(thumbPos * 100).toFixed(2)}%` }}
					/>
				</div>
			</div>
			{/* 每个刻度点正下方显示档位名，与刻度点同位对齐 */}
			<div className="relative mt-0.5 h-3">
				{levels.map((l, i) => (
					<span
						key={l.value}
						className={`absolute top-0 -translate-x-1/2 text-[9px] leading-none whitespace-nowrap transition-colors duration-150 ${
							i === liveIndex ? `font-medium ${LEVEL_COLORS[l.value]}` : "text-muted-foreground/80"
						}`}
						style={{ left: `${(snapFraction(i) * 100).toFixed(2)}%` }}
					>
						{l.label}
					</span>
				))}
			</div>
		</div>
	);
}

export default function ThinkingSelector({ currentLevel, availableThinkingLevels, onChanged }: ThinkingSelectorProps) {
	const { t } = useTranslation();
	const onChangedRef = useRef(onChanged);
	onChangedRef.current = onChanged;

	const LEVELS = useMemo(() => buildLevels(t), [t]);

	const handleSelect = useCallback((level: ThinkingLevel) => {
		onChangedRef.current?.(level);
	}, []);

	const availableSet = useMemo(() => {
		if (availableThinkingLevels && availableThinkingLevels.length > 0) {
			return new Set(availableThinkingLevels);
		}
		return new Set<ThinkingLevel>(["off"]);
	}, [availableThinkingLevels]);

	const supportsThinking = Array.from(availableSet).some((level) => level !== "off");

	const triggerTitle = supportsThinking
		? `${t("chat.thinkingLevel", "Thinking")}: ${LEVELS.find((l) => l.value === currentLevel)?.label ?? currentLevel}`
		: t("chat.thinkingUnsupported", "Current model does not support reasoning");

	const trigger = (
		<Button
			variant="line-ghost"
			size="sm"
			title={triggerTitle}
			aria-label={triggerTitle}
			className="group/selector h-7 shrink-0 font-mono text-[11px]"
		>
			<Brain
				data-icon="inline-start"
				className={`size-3 ${LEVEL_COLORS[currentLevel as ThinkingLevel] ?? LEVEL_COLORS.off}`}
			/>
		</Button>
	);

	// Only show levels the model actually supports. Always keep the currently
	// active level visible even if the SDK list is momentarily stale.
	const visibleLevels = useMemo(
		() => LEVELS.filter((l) => availableSet.has(l.value) || l.value === currentLevel),
		[LEVELS, availableSet, currentLevel],
	);
	const currentIndex = Math.max(
		0,
		visibleLevels.findIndex((l) => l.value === currentLevel),
	);

	return (
		<SimplePopover
			trigger={trigger}
			align="end"
			className="w-72 rounded-lg border border-hairline bg-popover p-3 shadow-lg"
		>
			{!supportsThinking && (
				<div className="mb-2 text-[10px] text-destructive/80">
					{t("chat.thinkingUnsupported", "Current model does not support reasoning")}
				</div>
			)}
			<ThinkingSlider
				ariaLabel={t("chat.thinkingLevel", "Thinking")}
				levels={visibleLevels}
				currentIndex={currentIndex}
				onSelect={(i) => {
					const level = visibleLevels[i];
					if (level) handleSelect(level.value);
				}}
			/>
		</SimplePopover>
	);
}
