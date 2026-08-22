// ============================================================
// PermissionModeSelector — ChatInput bottom bar permission mode toggle
// Click to cycle: always (green) → ask (amber) → plan (blue) → always
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import type { PermissionMode } from "@shared/types";
import { useSetAtom } from "jotai";
import { Shield } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { permissionModeAtomFamily } from "../../store/atoms";

interface ModeOption {
	mode: PermissionMode;
	labelKey: string;
	descriptionKey: string;
}

const MODE_OPTIONS: ModeOption[] = [
	{
		mode: "always",
		labelKey: "permission.always",
		descriptionKey: "permission.alwaysDesc",
	},
	{
		mode: "ask",
		labelKey: "permission.ask",
		descriptionKey: "permission.askDesc",
	},
	{
		mode: "plan",
		labelKey: "permission.plan",
		descriptionKey: "permission.planDesc",
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
	const { t } = useTranslation();
	const setMode = useSetAtom(permissionModeAtomFamily(agentId));
	const [switching, setSwitching] = useState(false);

	const current = MODE_OPTIONS.find((o) => o.mode === currentMode) ?? MODE_OPTIONS[0];
	const next = MODE_OPTIONS[(MODE_OPTIONS.indexOf(current) + 1) % MODE_OPTIONS.length];

	const handleCycle = useCallback(async () => {
		if (switching) return;
		setSwitching(true);
		try {
			const result = await window.look.setPermissionMode(agentId, next.mode);
			if (!result?.success) throw new Error(result?.error ?? "Permission mode switch failed");
			setMode(next.mode);
			// 无弹窗后用 toast 提示切换到了哪个模式
			toast(`${t(next.labelKey)} · ${t(next.descriptionKey)}`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("permission.switchFailed"));
		} finally {
			setSwitching(false);
		}
	}, [switching, agentId, next, setMode, t]);

	const title = `${t(current.labelKey)} · ${t(current.descriptionKey)}\n${t("permission.cycleHint", {
		next: t(next.labelKey),
	})}`;

	return (
		<Button
			variant="line-ghost"
			size="sm"
			className="group/perm h-7 shrink-0 font-mono text-[11px]"
			onClick={() => void handleCycle()}
			disabled={switching}
			title={title}
			aria-label={title}
		>
			<Shield className={`size-3 ${MODE_COLORS[currentMode]}`} data-icon="inline-start" />
		</Button>
	);
}
