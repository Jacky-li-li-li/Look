// ============================================================
// AboutTab — App info + 检查更新
// ============================================================

import { Badge } from "@look/ui/components/ui/badge";
import { Button } from "@look/ui/components/ui/button";
import { CircleCheck, Download, Loader2, Palette, RefreshCw, RotateCw, Settings, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppUpdate } from "../../hooks/useAppUpdate";
import { PixelAgentAvatar } from "../PixelAgentAvatar";
import type { CustomProviderStats, ProviderInfo } from "./types";

interface AboutTabProps {
	providers: ProviderInfo[];
	customStats: CustomProviderStats;
}

export default function AboutTab({ providers, customStats }: AboutTabProps) {
	const { t } = useTranslation();
	const appVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "1.0.0";
	const configured = providers.filter((p) => p.hasKey).length + customStats.configured;
	const { update, checkForUpdates, downloadUpdate, installUpdate } = useAppUpdate();
	const phase = update?.phase;

	return (
		<div className="flex h-full min-h-0 flex-col items-center justify-center gap-5 overflow-y-auto py-10 text-center">
			<PixelAgentAvatar size="lg" active />
			<div className="flex flex-col items-center gap-1.5">
				<h2 className="text-lg font-semibold tracking-tight">Look</h2>
				<Badge variant="secondary" className="font-mono text-[11px]">
					v{appVersion}
				</Badge>
			</div>
			<p className="text-[13px] text-muted-foreground max-w-xs leading-relaxed">
				Agent desktop application. Built with Electron, React, and pi SDK.
			</p>

			{/* ── 检查更新 ── */}
			<div className="flex flex-col items-center gap-2">
				{phase === "available" ? (
					<Button size="sm" onClick={() => void downloadUpdate()}>
						<Download className="size-3.5" />
						{t("update.downloadUpdate")}
						{update?.version ? ` · v${update.version}` : ""}
					</Button>
				) : phase === "downloaded" ? (
					<Button size="sm" onClick={() => void installUpdate()}>
						<RotateCw className="size-3.5" />
						{t("update.restartInstall")}
					</Button>
				) : (
					<Button
						size="sm"
						variant="outline"
						disabled={phase === "checking" || phase === "downloading"}
						onClick={() => void checkForUpdates()}
					>
						{phase === "checking" ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : (
							<RefreshCw className="size-3.5" />
						)}
						{t("update.checkForUpdates")}
					</Button>
				)}

				{phase === "checking" && (
					<span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
						{t("update.checking")}
					</span>
				)}
				{phase === "not-available" && (
					<span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
						<CircleCheck className="size-3" />
						{t("update.upToDate")}
					</span>
				)}
				{phase === "downloading" && (
					<div className="flex w-48 flex-col items-center gap-1">
						<div className="h-1 w-full overflow-hidden rounded-full bg-muted">
							<div
								className="h-full rounded-full bg-primary transition-[width]"
								style={{ width: `${Math.round(update?.percent ?? 0)}%` }}
							/>
						</div>
						<span className="text-[11px] text-muted-foreground">
							{t("update.downloading", { percent: Math.round(update?.percent ?? 0) })}
						</span>
					</div>
				)}
				{phase === "downloaded" && <span className="text-[11px] text-muted-foreground">{t("update.ready")}</span>}
				{phase === "error" && (
					<span className="flex max-w-xs items-start gap-1.5 text-[11px] text-destructive">
						<TriangleAlert className="mt-0.5 size-3 shrink-0" />
						<span className="break-all">{update?.error ?? t("update.failed")}</span>
					</span>
				)}
			</div>

			<div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
				<span className="flex items-center justify-center gap-1.5">
					<Settings className="size-3" /> shadcn/ui + Radix
				</span>
				<span className="flex items-center justify-center gap-1.5">
					<Palette className="size-3" /> Ink Wash design system
				</span>
			</div>
			<p className="text-[10px] text-muted-foreground/60 font-mono">
				{configured} provider{configured !== 1 ? "s" : ""} configured ·{" "}
				{providers.reduce((s, p) => s + p.modelsAvailable, 0) + customStats.totalModels} models
			</p>
		</div>
	);
}
