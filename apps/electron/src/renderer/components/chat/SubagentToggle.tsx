// ============================================================
// SubagentToggle — ChatInput 底部栏的 SubAgent 功能开关（Stage 2）
//
// 一个简单的图标按钮，切换 SubAgent 全局开关。
// 开启态：高亮颜色 + tooltip "SubAgent 已启用 - 复杂任务自动协作"
// 关闭态：灰色 + tooltip "SubAgent 已关闭 - 快速简单响应"
// 点击切换 subagentEnabledAtom，通过 IPC 同步到主进程
//（应用到所有活动会话 + 持久化为默认）。
// ============================================================

import { Button } from "@look/ui/components/ui/button";
import { useAtom } from "jotai";
import { Bot } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { subagentEnabledAtom } from "../../store/atoms";

export default function SubagentToggle() {
	const { t } = useTranslation();
	const [enabled, setEnabled] = useAtom(subagentEnabledAtom);
	const [switching, setSwitching] = useState(false);

	const handleToggle = useCallback(async () => {
		if (switching) return;
		const next = !enabled;
		setSwitching(true);
		try {
			const result = await window.look.setSubagentEnabled(next);
			if (!result?.success) throw new Error(result?.error ?? "SubAgent toggle failed");
			setEnabled(next);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("marketplace.subagentToggleFailed"));
		} finally {
			setSwitching(false);
		}
	}, [enabled, switching, setEnabled, t]);

	return (
		<Button
			variant="line-ghost"
			size="icon-sm"
			className="h-7 w-7 shrink-0"
			onClick={handleToggle}
			disabled={switching}
			title={enabled ? t("marketplace.subagentEnabledDesc") : t("marketplace.subagentDisabledDesc")}
			aria-label={enabled ? t("marketplace.subagentEnabled") : t("marketplace.subagentDisabled")}
		>
			<Bot
				className={`size-3.5 ${enabled ? "text-sky-500" : "text-muted-foreground/40"}`}
				data-icon="inline-start"
			/>
		</Button>
	);
}
