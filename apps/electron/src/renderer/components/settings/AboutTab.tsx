// ============================================================
// AboutTab — 应用身份卡（图标 + 名称 + 版本 + 更新控件）
//            + 版本志卡（墨迹时间线）
//
// 设计意图：与 Profile 页一致，收进居中 max-w-[1000px] 列，
// 使用设置页的卡片语言消除宽窗口下的空白。版本列表保留竖向
// 时间线：当前版本实心墨点，历史版本空心，点击展开更新内容。
// 更新控件收敛为身份卡右侧的按钮，状态反馈（进度/结果）以
// 按钮下方的轻量文本呈现。
// ============================================================

import { Card, CardContent, CardHeader, CardTitle } from "@look/ui/components/ui/card";
import { CircleCheck, Loader2, RefreshCw, RotateCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import appIconUrl from "../../../../assets/icon-1024.png";
import { CHANGELOG } from "../../data/changelog";
import { useAppUpdate } from "../../hooks/useAppUpdate";

function localize(items: { zh: string; en: string; ja?: string }[], lang: string): string[] {
	return items.map((item) =>
		lang.startsWith("zh") ? item.zh : lang.startsWith("ja") ? (item.ja ?? item.en) : item.en,
	);
}

export default function AboutTab() {
	const { t, i18n } = useTranslation();
	const appVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "1.0.0";
	const { update, checkForUpdates, installUpdate } = useAppUpdate();
	const phase = update?.phase;
	const [expanded, setExpanded] = useState<string | null>(null);

	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto">
			<div className="mx-auto flex w-full max-w-[1000px] flex-col gap-4 px-4 py-5">
				{/* ── 身份卡：图标 + 名称 + 版本，更新控件与状态反馈右对齐 ── */}
				<Card size="sm">
					<CardContent className="flex items-center gap-4 px-4 py-3.5">
						<img
							src={appIconUrl}
							alt="Look"
							className="size-12 shrink-0 rounded-[22%] ring-1 ring-foreground/10"
						/>
						<div className="min-w-0 flex-1">
							<h2 className="text-[15px] font-semibold tracking-tight">Look</h2>
							<p className="mt-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">v{appVersion}</p>
						</div>

						{/* 更新控件：按钮形态随阶段切换 */}
						<div className="flex shrink-0 flex-col items-end gap-1.5">
							{phase === "available" ? (
								<button
									type="button"
									disabled
									title={`${t("update.autoDownloading", { version: update?.version ?? "" })}`}
									className="flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground disabled:opacity-60"
								>
									<Loader2 className="size-3 animate-spin" />
									{t("update.downloadingTitle")}
								</button>
							) : phase === "downloaded" ? (
								<button
									type="button"
									onClick={() => void installUpdate()}
									className="flex items-center gap-1.5 rounded-md border border-hairline bg-primary/10 px-2.5 py-1.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<RotateCw className="size-3" />
									{t("update.restartInstall")}
								</button>
							) : (
								<button
									type="button"
									disabled={phase === "checking" || phase === "downloading"}
									onClick={() => void checkForUpdates()}
									className="flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
								>
									{phase === "checking" || phase === "downloading" ? (
										<Loader2 className="size-3 animate-spin" />
									) : (
										<RefreshCw className="size-3" />
									)}
									{phase === "checking"
										? t("update.checking")
										: phase === "downloading"
											? t("update.downloadingTitle")
											: t("update.checkForUpdates")}
								</button>
							)}

							{/* 状态反馈：右对齐轻量文本 */}
							{phase === "available" && (
								<p className="text-[11px] text-muted-foreground">
									{t("update.available")}
									{update?.version ? ` v${update.version}` : ""}
								</p>
							)}
							{phase === "not-available" && (
								<p className="flex items-center gap-1 text-[11px] text-muted-foreground">
									<CircleCheck className="size-3" />
									{t("update.upToDate")}
								</p>
							)}
							{phase === "downloading" && (
								<div className="flex w-40 items-center gap-2">
									<div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
										<div
											className="h-full rounded-full bg-primary transition-[width]"
											style={{ width: `${Math.round(update?.percent ?? 0)}%` }}
										/>
									</div>
									<span className="font-mono text-[10px] tabular-nums text-muted-foreground">
										{Math.round(update?.percent ?? 0)}%
									</span>
								</div>
							)}
							{phase === "downloaded" && (
								<p className="text-[11px] text-muted-foreground">{t("update.ready")}</p>
							)}
							{phase === "error" && (
								<p className="flex max-w-[220px] items-start gap-1.5 text-[11px] text-destructive">
									<TriangleAlert className="mt-0.5 size-3 shrink-0" />
									<span className="break-all">{update?.error ?? t("update.failed")}</span>
								</p>
							)}
						</div>
					</CardContent>
				</Card>

				{/* ── 版本志卡：墨迹时间线 ── */}
				<Card size="sm">
					<CardHeader className="border-b border-hairline px-4 py-2.5">
						<CardTitle className="text-[13px] font-medium">{t("about.releaseNotes")}</CardTitle>
					</CardHeader>
					<CardContent className="px-4 py-3.5">
						<div className="relative ml-[5px] border-l border-hairline pl-5">
							{CHANGELOG.map((entry) => {
								const isCurrent = entry.version === appVersion;
								const isOpen = expanded === entry.version;
								return (
									<div key={entry.version} className="relative pb-1">
										{/* 时间线节点：当前实心，历史空心 */}
										<span
											className={`absolute top-[9px] -left-[25.5px] size-[11px] rounded-full border-2 ${
												isCurrent ? "border-primary bg-primary" : "border-muted-foreground/40 bg-popover"
											}`}
										/>
										<button
											type="button"
											onClick={() => setExpanded(isOpen ? null : entry.version)}
											className="flex w-full items-baseline gap-2 rounded-md py-1.5 pr-1 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
										>
											<span
												className={`font-mono text-[13px] tabular-nums ${isCurrent ? "font-semibold" : ""}`}
											>
												v{entry.version}
											</span>
											<span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
												{entry.date}
											</span>
											{isCurrent && (
												<span className="rounded-sm bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
													{t("about.current")}
												</span>
											)}
											<span
												className={`ml-auto text-[11px] text-muted-foreground/50 transition-transform duration-200 ${
													isOpen ? "rotate-180" : ""
												}`}
											>
												⌄
											</span>
										</button>
										{/* 下拉抽屉：grid rows 过渡实现平滑展开 */}
										<div
											className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
												isOpen ? "[grid-template-rows:1fr]" : "[grid-template-rows:0fr]"
											}`}
										>
											<ul className="overflow-hidden">
												{localize(entry.items, i18n.language).map((text, index) => (
													<li
														key={`${entry.version}-${index}`}
														className="flex items-start gap-2 py-1 text-[12px] leading-relaxed text-muted-foreground"
													>
														<span className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground/40" />
														{text}
													</li>
												))}
											</ul>
										</div>
									</div>
								);
							})}
						</div>
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
