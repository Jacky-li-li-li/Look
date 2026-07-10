// ============================================================
// SubagentToggle — ChatInput 底部栏的 SubAgent 功能开关（Stage 2）
//
// 一个简单的图标按钮，切换 SubAgent 全局开关。
// 开启态：高亮颜色 + tooltip "SubAgent 已启用 - 复杂任务自动协作"
// 关闭态：灰色 + tooltip "SubAgent 已关闭 - 快速简单响应"
// 点击切换 subagentEnabledAtom，通过 IPC 同步到主进程
//（应用到所有活动会话 + 持久化为默认）。
// ============================================================

import { Button } from "@shared/components/ui/button";
import { useAtom } from "jotai";
import { Bot } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { subagentEnabledAtom } from "../../store/atoms";

export default function SubagentToggle() {
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
			toast.error(error instanceof Error ? error.message : "SubAgent 开关切换失败");
		} finally {
			setSwitching(false);
		}
	}, [enabled, switching, setEnabled]);

	return (
		<Button
			variant="line"
			size="icon-sm"
			className="h-7 w-7"
			onClick={handleToggle}
			disabled={switching}
			title={enabled ? "SubAgent 已启用 — 复杂任务自动协作" : "SubAgent 已关闭 — 快速简单响应"}
			aria-label={enabled ? "SubAgent 已启用" : "SubAgent 已关闭"}
		>
			<Bot
				className={`size-3.5 ${enabled ? "text-sky-500" : "text-muted-foreground/40"}`}
				data-icon="inline-start"
			/>
		</Button>
	);
}
