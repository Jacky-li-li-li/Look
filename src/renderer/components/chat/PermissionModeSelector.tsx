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
import { toast } from "sonner";
import { permissionModeAtomFamily } from "../store/atoms";

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
		labelZh: "规划后执行",
		description: "只读探索、提问并提交计划；批准后执行",
	},
];

const MODE_COLORS: Record<PermissionMode, string> = {
	always: "text-emerald-500 dark:text-emerald-400",
	ask: "text-amber-500 dark:text-amber-300",
	plan: "text-sky-500 dark:text-sky-400",
};

interface PermissionModeSelectorProps {
	agentId: string;
	currentMode: PermissionMode;
}

export default function PermissionModeSelector({ agentId, currentMode }: PermissionModeSelectorProps) {
	const setMode = useSetAtom(permissionModeAtomFamily(agentId));
	const [switching, setSwitching] = useState(false);

	const current = MODE_OPTIONS.find((o) => o.mode === currentMode) ?? MODE_OPTIONS[0];

	const handleSwitch = useCallback(
		async (mode: PermissionMode) => {
			if (mode === currentMode || switching) return;
			setSwitching(true);
			try {
				const result = await window.look.setPermissionMode(agentId, mode);
				if (!result?.success) throw new Error(result?.error ?? "Permission mode switch failed");
				setMode(mode);
			} catch (error) {
				toast.error(error instanceof Error ? error.message : "权限模式切换失败");
			} finally {
				setSwitching(false);
			}
		},
		[agentId, currentMode, switching, setMode],
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
					aria-label={current.description}
				>
					<Shield className={`size-3 ${MODE_COLORS[currentMode]}`} data-icon="inline-start" />
					<ChevronDown
						data-icon="inline-end"
						className="size-3 transition-transform duration-150 group-data-[state=open]/perm:rotate-180"
					/>
				</Button>
			}
		>
			{({ close }) =>
				MODE_OPTIONS.map((option) => {
					const isActive = option.mode === currentMode;
					return (
						<button
							key={option.mode}
							type="button"
							disabled={isActive || switching}
							onClick={() => {
								handleSwitch(option.mode);
								close();
							}}
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
				})
			}
		</SimplePopover>
	);
}
