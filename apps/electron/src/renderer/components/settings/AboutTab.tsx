// ============================================================
// AboutTab — App info
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Palette, Settings } from "lucide-react";
import { PixelAgentAvatar } from "../PixelAgentAvatar";
import type { CustomProviderStats, ProviderInfo } from "./types";

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
		</div>
	);
}
