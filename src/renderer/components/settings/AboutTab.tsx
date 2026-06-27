// ============================================================
// AboutTab — App info + update checker
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { useAtomValue } from "jotai";
import { Loader2, Palette, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { updateStatusAtom } from "../../store/atoms";
import { PixelAgentAvatar } from "../PixelAgentAvatar";
import type { CustomProviderStats, ProviderInfo } from "./types";

const api = (window as any).look;

function UpdateCheckButton() {
	const { t } = useTranslation();
	const updateStatus = useAtomValue(updateStatusAtom);

	if (!updateStatus || updateStatus.stage === "not-available" || updateStatus.stage === "error") {
		return (
			<button
				type="button"
				onClick={() => api?.checkForUpdates?.()}
				className="rounded-md border border-hairline px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-accent transition-colors"
			>
				{t("settings.checkForUpdates", "Check for Updates")}
			</button>
		);
	}

	if (updateStatus.stage === "checking") {
		return (
			<span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
				<Loader2 className="size-3 animate-spin" />
				Checking...
			</span>
		);
	}

	if (updateStatus.stage === "available") {
		return (
			<div className="flex flex-col items-center gap-2">
				<span className="text-[12px] font-medium text-foreground">Version {updateStatus.version} available</span>
				<button
					type="button"
					onClick={() => api?.downloadUpdate?.()}
					className="rounded-md bg-foreground px-3 py-1.5 text-[11px] font-medium text-background hover:opacity-90"
				>
					Download Update
				</button>
			</div>
		);
	}

	if (updateStatus.stage === "downloading") {
		return (
			<span className="text-[11px] text-muted-foreground">
				Downloading: {(updateStatus.percent ?? 0).toFixed(0)}%
			</span>
		);
	}

	if (updateStatus.stage === "downloaded") {
		return (
			<div className="flex flex-col items-center gap-2">
				<span className="text-[12px] text-foreground">Update ready</span>
				<button
					type="button"
					onClick={() => api?.installUpdate?.()}
					className="rounded-md bg-foreground px-3 py-1.5 text-[11px] font-medium text-background hover:opacity-90"
				>
					Restart to Install
				</button>
			</div>
		);
	}

	return null;
}

interface AboutTabProps {
	providers: ProviderInfo[];
	customStats: CustomProviderStats;
}

export default function AboutTab({ providers, customStats }: AboutTabProps) {
	const appVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "1.0.0";
	const configured = providers.filter((p) => p.hasKey).length + customStats.configured;

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
			<UpdateCheckButton />
		</div>
	);
}
