// ============================================================
// PermissionModeSelector — ChatInput bottom bar permission mode toggle
// Three modes: always (green), ask (amber), plan (blue)
// ============================================================

import { Button } from "@shared/components/ui/button";
import SimplePopover from "@shared/components/ui/simple-popover";
import type { PermissionMode } from "@shared/types";
import { useSetAtom } from "jotai";
import { Check, ChevronDown, Shield } from "lucide-react";
import { useCallback, useState } from "react";
import { permissionModeAtom } from "../store/atoms";

const api = (window as any).look;

interface ModeOption {
	mode: PermissionMode;
	label: string;
	labelZh: string;
	description: string;
}

const MODE_OPTIONS: ModeOption[] = [
	{
		mode: "always",
		label: "Always",
		labelZh: "始终信任",
		description: "本次会话授权所有工具，无需确认",
	},
	{
		mode: "ask",
		label: "Ask",
		labelZh: "每次询问",
		description: "写入类工具调用前弹出确认对话框",
	},
	{
		mode: "plan",
		label: "Plan",
		labelZh: "仅规划",
		description: "只产出 plan.md 文档，不修改项目代码",
	},
];

const MODE_COLORS: Record<PermissionMode, string> = {
	always: "text-emerald-500",
	ask: "text-amber-500",
	plan: "text-sky-500",
};

interface PermissionModeSelectorProps {
	currentMode: PermissionMode;
}

export default function PermissionModeSelector({ currentMode }: PermissionModeSelectorProps) {
	const setMode = useSetAtom(permissionModeAtom);
	const [switching, setSwitching] = useState(false);

	const current = MODE_OPTIONS.find((o) => o.mode === currentMode) ?? MODE_OPTIONS[0];

	const handleSwitch = useCallback(
		async (mode: PermissionMode) => {
			if (mode === currentMode || switching) return;
			setSwitching(true);
			try {
				if (api?.setPermissionMode) {
					const result = await api.setPermissionMode(mode);
					if (result?.success) {
						setMode(mode);
					}
				}
			} catch {
				// IPC error — keep current mode
			} finally {
				setSwitching(false);
			}
		},
		[currentMode, switching, setMode],
	);

	return (
		<SimplePopover
			align="start"
			className="w-52 rounded-lg border border-hairline bg-popover p-1 shadow-lg"
			trigger={
				<Button
					variant="line"
					size="sm"
					className="group/perm h-7 gap-1 font-mono text-[11px]"
					title={current.description}
				>
					<Shield className={`size-3 ${MODE_COLORS[currentMode]}`} />
					<span className="truncate max-w-14">{current.label}</span>
					<ChevronDown className="size-3 transition-transform duration-150 group-data-[state=open]/perm:rotate-180" />
				</Button>
			}
		>
			{MODE_OPTIONS.map((option) => {
				const isActive = option.mode === currentMode;
				return (
					<button
						key={option.mode}
						type="button"
						disabled={isActive || switching}
						onClick={() => handleSwitch(option.mode)}
						className="flex w-full cursor-pointer items-start gap-2 rounded-md px-2.5 py-2 text-left text-[12px] outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent disabled:cursor-default disabled:opacity-50"
					>
						<Shield className={`mt-0.5 size-3 shrink-0 ${MODE_COLORS[option.mode]}`} />
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1">
								<span className="font-medium">{option.label}</span>
								<span className="text-[10px] text-muted-foreground">{option.labelZh}</span>
								{isActive && <Check className="ml-auto size-3 shrink-0" />}
							</div>
							<p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{option.description}</p>
						</div>
					</button>
				);
			})}
		</SimplePopover>
	);
}
