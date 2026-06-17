// ============================================================
// ThinkingSelector — Simple Popover (Ink Wash, no Radix DropdownMenu)
// ============================================================

import { Button } from "@shared/components/ui/button";
import SimplePopover from "@shared/components/ui/simple-popover";
import type { ThinkingLevel } from "@shared/types";
import { Brain, Check, ChevronDown } from "lucide-react";
import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

const LEVELS: { value: ThinkingLevel; label: string; desc: string }[] = [
	{ value: "off", label: "Off", desc: "No extended thinking" },
	{ value: "minimal", label: "Minimal", desc: "~1K tokens" },
	{ value: "low", label: "Low", desc: "~4K tokens" },
	{ value: "medium", label: "Medium", desc: "~10K tokens" },
	{ value: "high", label: "High", desc: "~32K tokens" },
	{ value: "xhigh", label: "X-High", desc: "Maximum reasoning" },
];

interface ThinkingSelectorProps {
	agentId: string;
	currentLevel: string;
	supportsThinking: boolean;
	availableThinkingLevels?: ThinkingLevel[];
	onChanged: (level: string) => void;
}

export default function ThinkingSelector({
	agentId,
	currentLevel,
	supportsThinking,
	availableThinkingLevels,
	onChanged,
}: ThinkingSelectorProps) {
	const { t } = useTranslation();
	const onChangedRef = useRef(onChanged);
	onChangedRef.current = onChanged;

	const handleSelect = useCallback((level: string) => {
		onChangedRef.current?.(level);
	}, []);

	const current = LEVELS.find((l) => l.value === currentLevel) ?? LEVELS[0];

	// If the main process has provided the exact list of levels supported by
	// the current model (from the pi SDK), use it. Otherwise fall back to the
	// coarse supportsThinking flag for backward compatibility.
	const availableSet = useMemo(() => {
		if (availableThinkingLevels && availableThinkingLevels.length > 0) {
			return new Set(availableThinkingLevels);
		}
		return supportsThinking ? new Set(LEVELS.map((l) => l.value)) : new Set<ThinkingLevel>(["off"]);
	}, [availableThinkingLevels, supportsThinking]);

	console.log("[ThinkingSelector] render", { agentId, currentLevel, supportsThinking, availableThinkingLevels, availableSet: Array.from(availableSet) });

	const triggerTitle = supportsThinking
		? `${t("chat.thinkingLevel", "Thinking")}: ${current.label}`
		: t("chat.thinkingUnsupported", "Current model does not support reasoning");

	const trigger = (
		<Button
			variant="line"
			size="sm"
			title={triggerTitle}
			className="group/selector h-7 font-mono text-[11px]"
		>
			<Brain data-icon="inline-start" className="size-3" />
			{current.label}
			<ChevronDown
				data-icon="inline-end"
				className="size-3 transition-transform duration-150 group-data-[state=open]/selector:rotate-180"
			/>
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
						onClick={() => handleSelect(l.value)}
						className="flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-md px-1.5 py-1 text-left text-[12px] outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:cursor-default disabled:opacity-40"
					>
						<span className="flex items-center gap-1.5 font-medium">
							{l.label}
							{isActive && <Check className="size-3" />}
						</span>
						<span className="text-[10px] text-muted-foreground">{l.desc}</span>
					</button>
				);
			})}
		</SimplePopover>
	);
}
