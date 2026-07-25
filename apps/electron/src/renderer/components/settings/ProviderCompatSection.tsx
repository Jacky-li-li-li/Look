// ============================================================
// ProviderCompatSection — compat toggle switches per API protocol
// ============================================================

import { cn } from "@look/ui";
import { Switch } from "@look/ui/components/ui/switch";
import { Info } from "lucide-react";
import type { ApiProtocol, ProviderCompatState } from "./provider-form-state";

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<div className={cn("mb-2 flex items-center gap-2", className)}>
			<div className="h-3 w-0.5 rounded-full bg-border" />
			<span className="text-[11px] font-medium text-muted-foreground">{children}</span>
		</div>
	);
}

function CompatToggle({
	checked,
	onChange,
	label,
	tip,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
	label: string;
	tip: string;
}) {
	return (
		<div className="group flex items-center justify-between gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/30">
			<button
				type="button"
				title={tip}
				onClick={() => onChange(!checked)}
				className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-[11px] text-muted-foreground transition-colors group-hover:text-foreground"
			>
				<Info className="size-3 shrink-0 text-muted-foreground/40" />
				<span className="truncate">{label}</span>
			</button>
			<Switch checked={checked} onCheckedChange={onChange} className="scale-75 shrink-0" />
		</div>
	);
}

export default function ProviderCompatSection({
	compat,
	api,
	onChange,
	t,
}: {
	compat: ProviderCompatState;
	api: ApiProtocol;
	onChange: <K extends keyof ProviderCompatState>(key: K, value: boolean) => void;
	t: (key: string) => string;
}) {
	return (
		<section>
			<SectionLabel>{t("settings.customProviders.dialog.field.compat")}</SectionLabel>
			<p className="mb-2 text-[10px] leading-snug text-muted-foreground/60">
				{t("settings.customProviders.dialog.compatHint")}
			</p>
			<div className="space-y-1.5 rounded-md border border-hairline bg-muted/15 p-2.5">
				{api === "anthropic-messages" && (
					<>
						<CompatToggle
							checked={compat.forceAdaptiveThinking}
							onChange={(v) => onChange("forceAdaptiveThinking", v)}
							label={t("settings.customProviders.compat.anthropic.forceAdaptiveThinking")}
							tip={t("settings.customProviders.compat.anthropic.forceAdaptiveThinkingTip")}
						/>
						<CompatToggle
							checked={compat.supportsEagerToolInputStreaming}
							onChange={(v) => onChange("supportsEagerToolInputStreaming", v)}
							label={t("settings.customProviders.compat.anthropic.supportsEagerToolInputStreaming")}
							tip={t("settings.customProviders.compat.anthropic.supportsEagerToolInputStreamingTip")}
						/>
						<CompatToggle
							checked={compat.allowEmptySignature}
							onChange={(v) => onChange("allowEmptySignature", v)}
							label={t("settings.customProviders.compat.anthropic.allowEmptySignature")}
							tip={t("settings.customProviders.compat.anthropic.allowEmptySignatureTip")}
						/>
					</>
				)}
				{api === "openai-completions" && (
					<>
						<CompatToggle
							checked={compat.supportsDeveloperRole}
							onChange={(v) => onChange("supportsDeveloperRole", v)}
							label={t("settings.customProviders.compat.openai.supportsDeveloperRole")}
							tip={t("settings.customProviders.compat.openai.supportsDeveloperRoleTip")}
						/>
						<CompatToggle
							checked={compat.supportsReasoningEffort}
							onChange={(v) => onChange("supportsReasoningEffort", v)}
							label={t("settings.customProviders.compat.openai.supportsReasoningEffort")}
							tip={t("settings.customProviders.compat.openai.supportsReasoningEffortTip")}
						/>
					</>
				)}
				{api === "openai-responses" && (
					<CompatToggle
						checked={compat.supportsDeveloperRole}
						onChange={(v) => onChange("supportsDeveloperRole", v)}
						label={t("settings.customProviders.compat.openai.supportsDeveloperRole")}
						tip={t("settings.customProviders.compat.openai.supportsDeveloperRoleTip")}
					/>
				)}
				{api === "google-generative-ai" && (
					<p className="py-1 text-[10px] text-muted-foreground/60">
						{t("settings.customProviders.dialog.noCompatOptions")}
					</p>
				)}
			</div>
		</section>
	);
}
