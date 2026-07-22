// ============================================================
// AgentAvatarPicker — Open Peeps 头像选择器
//
// 只支持选择预置的 Open Peeps SVG，不再提供 emoji 输入。
// ============================================================

import { cn } from "@shared/lib/utils";
import { useTranslation } from "react-i18next";
import AgentAvatar from "./AgentAvatar";
import { getOpenPeepId, getOpenPeepPreset, makeOpenPeepIcon, OPEN_PEEPS } from "./openPeeps";

interface AgentAvatarPickerProps {
	value?: string;
	onChange: (icon: string | undefined) => void;
}

function isValidPeepIcon(value: string | undefined): boolean {
	if (!value) return false;
	const id = getOpenPeepId(value);
	return id !== undefined && getOpenPeepPreset(id) !== undefined;
}

export default function AgentAvatarPicker({ value, onChange }: AgentAvatarPickerProps) {
	const { t } = useTranslation();
	const selectedId = getOpenPeepId(value) ?? OPEN_PEEPS[0].id;
	const invalid = !!value && !isValidPeepIcon(value);

	return (
		<div className="space-y-2">
			<div
				className="grid grid-cols-5 gap-2"
				role="group"
				aria-label={t("agentAvatar.title", "Open Peeps 头像选择")}
			>
				{OPEN_PEEPS.map((preset) => {
					const icon = makeOpenPeepIcon(preset.id);
					const selected = selectedId === preset.id;
					const label = t(`agentAvatar.${preset.id}`);
					return (
						<button
							key={preset.id}
							type="button"
							onClick={() => onChange(icon)}
							title={label}
							aria-label={label}
							aria-pressed={selected}
							className={cn(
								"flex flex-col items-center gap-1 rounded-md border p-1.5 text-center transition-colors",
								selected
									? "border-accent bg-accent/10"
									: "border-hairline bg-card/40 hover:border-hairline hover:bg-accent/5",
							)}
						>
							<AgentAvatar icon={icon} className="h-8 w-8" />
							<span className="text-[9px] text-muted-foreground">{label}</span>
						</button>
					);
				})}
			</div>
			{invalid && (
				<p className="text-[10px] text-amber-600 dark:text-amber-400">
					当前图标已失效，请选择一个新的 Open Peeps 头像。
				</p>
			)}
		</div>
	);
}
