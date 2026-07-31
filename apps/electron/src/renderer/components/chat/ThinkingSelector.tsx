// ============================================================
// ThinkingSelector — Simple Popover (Ink Wash, no Radix DropdownMenu)
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import SimplePopover from "@look/ui/components/ui/simple-popover";
import type { ThinkingLevel } from "@shared/types";
import type { TFunction } from "i18next";
import { Brain, Check } from "lucide-react";
import { useCallback, useMemo, useRef } from "react";
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
		{ value: "max", label: t("agent.thinkingMax", "Max"), desc: t("agent.thinkingMaxDesc", "Full reasoning") },
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

export default function ThinkingSelector({ currentLevel, availableThinkingLevels, onChanged }: ThinkingSelectorProps) {
	const { t } = useTranslation();
	const onChangedRef = useRef(onChanged);
	onChangedRef.current = onChanged;

	const LEVELS = useMemo(() => buildLevels(t), [t]);

	const handleSelect = useCallback((level: ThinkingLevel) => {
		onChangedRef.current?.(level);
	}, []);

	const current = LEVELS.find((l) => l.value === currentLevel) ?? LEVELS[0];

	const availableSet = useMemo(() => {
		if (availableThinkingLevels && availableThinkingLevels.length > 0) {
			return new Set(availableThinkingLevels);
		}
		return new Set<ThinkingLevel>(["off"]);
	}, [availableThinkingLevels]);

	const supportsThinking = Array.from(availableSet).some((level) => level !== "off");

	const triggerTitle = supportsThinking
		? `${t("chat.thinkingLevel", "Thinking")}: ${current.label}`
		: t("chat.thinkingUnsupported", "Current model does not support reasoning");

	const trigger = (
		<Button
			variant="line-ghost"
			size="sm"
			title={triggerTitle}
			aria-label={triggerTitle}
			className="group/selector h-7 font-mono text-[11px]"
		>
			<Brain data-icon="inline-start" className={`size-3 ${LEVEL_COLORS[current.value]}`} />
		</Button>
	);

	// Only show levels the model actually supports. Always keep the currently
	// active level visible even if the SDK list is momentarily stale.
	const visibleLevels = LEVELS.filter((l) => availableSet.has(l.value) || l.value === currentLevel);

	return (
		<SimplePopover
			trigger={trigger}
			align="end"
			className="glass-panel-strong w-56 overflow-y-auto rounded-xl border p-1 shadow-xl ring-1 ring-foreground/10"
		>
			{({ close }) => (
				<>
					{!supportsThinking && (
						<div className="px-1.5 py-1 text-[10px] text-destructive/80">
							{t("chat.thinkingUnsupported", "Current model does not support reasoning")}
						</div>
					)}
					{visibleLevels.map((l) => {
						const isActive = l.value === currentLevel;
						return (
							<button
								key={l.value}
								type="button"
								disabled={isActive}
								onClick={() => {
									handleSelect(l.value);
									close();
								}}
								className="flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-md px-1.5 py-1 text-left text-[12px] outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:cursor-default disabled:opacity-40"
							>
								<span className={`flex items-center gap-1.5 font-medium ${LEVEL_COLORS[l.value]}`}>
									<span className="size-1.5 rounded-full bg-current" />
									{l.label}
									{isActive && <Check className="size-3" />}
								</span>
								<span className="text-[10px] text-muted-foreground">{l.desc}</span>
							</button>
						);
					})}
				</>
			)}
		</SimplePopover>
	);
}
