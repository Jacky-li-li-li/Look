// ============================================================
// AppUpdateNotifier — 全局自动更新提示（sonner toast）
//
// 订阅 appUpdateAtom（由主进程 update:status 事件驱动），
// 用固定 toast id 原地更新：available → downloading → downloaded。
// downloaded 后主进程立即重启安装，toast 仅作短暂提示。
// 仅在发现新版本后才出现；checking / not-available / error 不打扰用户
// （手动检查的结果在设置页 AboutTab 展示）。
// ============================================================

import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAppUpdate } from "../hooks/useAppUpdate";
import { appUpdateAtom } from "../store/atoms";

const TOAST_ID = "app-update";

export default function AppUpdateNotifier() {
	const { t } = useTranslation();
	const update = useAtomValue(appUpdateAtom);
	const { downloadUpdate } = useAppUpdate();

	useEffect(() => {
		if (!update) return;
		switch (update.phase) {
			case "available":
				toast(t("update.available"), {
					id: TOAST_ID,
					description: update.version ? t("update.versionAvailable", { version: update.version }) : undefined,
					duration: Number.POSITIVE_INFINITY,
					action: { label: t("update.download"), onClick: () => void downloadUpdate() },
					cancel: { label: t("update.later"), onClick: () => {} },
				});
				break;
			case "downloading": {
				const percent = Math.round(update.percent ?? 0);
				// 与 available/downloaded 一样走 toast()（sonner 按 id 浅合并更新，
				// 混用 toast.custom 会残留旧 description/action/cancel）；进度条
				// 放在 description 里，action/cancel 显式传 undefined 清掉残留。
				toast(t("update.downloadingTitle"), {
					id: TOAST_ID,
					description: (
						<div className="mt-1.5 w-full">
							<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
								<div
									className="h-full rounded-full bg-foreground transition-[width] duration-200 motion-reduce:transition-none"
									style={{ width: `${percent}%` }}
								/>
							</div>
							<div className="mt-1.5 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
								{percent}%
							</div>
						</div>
					),
					duration: Number.POSITIVE_INFINITY,
					action: undefined,
					cancel: undefined,
				});
				break;
			}
			case "downloaded":
				// 主进程随即 quitAndInstall，这只是重启前的短暂提示。
				toast(t("update.ready"), {
					id: TOAST_ID,
					description: update.version,
					action: undefined,
					cancel: undefined,
				});
				break;
			default:
				toast.dismiss(TOAST_ID);
				break;
		}
	}, [update, t, downloadUpdate]);

	return null;
}
