// ============================================================
// SidebarUpdateButton — 侧栏底部的一键更新入口
//
// 检测到新版本（主进程 update:status → appUpdateAtom）时在侧栏底部
// 出现；点击即下载，下载完成后主进程自动重启安装，一气呵成无需二次
// 确认。下载中显示百分比；downloaded 后主进程随即 quitAndInstall，
// 只是重启前的短暂状态。toast（AppUpdateNotifier）负责首次通知，
// 这个按钮负责在用户关掉 toast 后仍保留入口。
// ============================================================

import { useAtomValue } from "jotai";
import { CircleArrowUp, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppUpdate } from "../../hooks/useAppUpdate";
import { appUpdateAtom } from "../../store/atoms";

export default function SidebarUpdateButton() {
	const { t } = useTranslation();
	const update = useAtomValue(appUpdateAtom);
	const { downloadUpdate } = useAppUpdate();
	const phase = update?.phase;

	if (phase !== "available" && phase !== "downloading" && phase !== "downloaded") return null;

	const busy = phase !== "available";
	const label =
		phase === "available"
			? t("update.sidebarCta")
			: phase === "downloading"
				? `${Math.round(update?.percent ?? 0)}%`
				: t("update.installing");

	return (
		<div className="flex shrink-0 justify-end border-t border-hairline px-3 py-2">
			<button
				type="button"
				disabled={busy}
				onClick={() => void downloadUpdate()}
				title={update?.version ? t("update.versionAvailable", { version: update.version }) : t("update.available")}
				className="flex items-center gap-1.5 rounded-full border border-hairline bg-foreground/[0.04] px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.09] hover:text-foreground disabled:opacity-70"
			>
				{busy ? <Loader2 className="size-3 animate-spin" /> : <CircleArrowUp className="size-3" />}
				{label}
			</button>
		</div>
	);
}
