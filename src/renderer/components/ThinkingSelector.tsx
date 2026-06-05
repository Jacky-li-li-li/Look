// ============================================================
// ThinkingSelector — Simple Popover (Ink Wash, no Radix DropdownMenu)
// ============================================================

import { Button } from "@shared/components/ui/button";
import SimplePopover from "@shared/components/ui/simple-popover";
import { Brain, Check, ChevronDown } from "lucide-react";
import { useCallback, useRef } from "react";

const LEVELS = [
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
	onChanged: (level: string) => void;
}

export default function ThinkingSelector({ agentId, currentLevel, onChanged }: ThinkingSelectorProps) {
	const onChangedRef = useRef(onChanged);
	onChangedRef.current = onChanged;

	const handleSelect = useCallback((level: string) => {
		onChangedRef.current?.(level);
	}, []);

	const current = LEVELS.find((l) => l.value === currentLevel) ?? LEVELS[0];

	const trigger = (
		<Button variant="line" size="sm" className="group/selector h-7 font-mono text-[11px]">
			<Brain data-icon="inline-start" className="size-3" />
			{current.label}
			<ChevronDown
				data-icon="inline-end"
				className="size-3 transition-transform duration-150 group-data-[state=open]/selector:rotate-180"
			/>
		</Button>
	);

	return (
		<SimplePopover
			trigger={trigger}
			align="end"
			className="glass-panel-strong w-56 overflow-y-auto rounded-xl border p-1 shadow-xl ring-1 ring-foreground/10"
		>
			{LEVELS.map((l) => (
				<button
					key={l.value}
					type="button"
					disabled={l.value === currentLevel}
					onClick={() => handleSelect(l.value)}
					className="flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-md px-1.5 py-1 text-left text-[12px] outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:cursor-default disabled:opacity-50"
				>
					<span className="flex items-center gap-1.5 font-medium">
						{l.label}
						{l.value === currentLevel && <Check className="size-3" />}
					</span>
					<span className="text-[10px] text-muted-foreground">{l.desc}</span>
				</button>
			))}
		</SimplePopover>
	);
}
