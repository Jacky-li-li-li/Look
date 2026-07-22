// ============================================================
// ProviderConnectionFields — API protocol / name / baseUrl / apiKey
// ============================================================

import { Button } from "@shared/components/ui/button";
import { Input } from "@shared/components/ui/input";
import { Label } from "@shared/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@shared/components/ui/select";
import { cn } from "@shared/lib/utils";
import type { TFunction } from "i18next";
import { Eye, EyeOff } from "lucide-react";
import {
	API_PROTOCOL_LABELS,
	type ApiProtocol,
	type ProviderFormErrors,
	type ProviderFormState,
} from "./provider-form-state";

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<div className={cn("mb-2 flex items-center gap-2", className)}>
			<div className="h-3 w-0.5 rounded-full bg-border" />
			<span className="text-[11px] font-medium text-muted-foreground">{children}</span>
		</div>
	);
}

export default function ProviderConnectionFields({
	form,
	patchForm,
	errors,
	isEdit,
	t,
}: {
	form: ProviderFormState;
	patchForm: <K extends keyof ProviderFormState>(key: K, value: ProviderFormState[K]) => void;
	errors: ProviderFormErrors;
	isEdit: boolean;
	t: TFunction;
}) {
	return (
		<section>
			<SectionLabel>{t("settings.customProviders.dialog.connection")}</SectionLabel>
			<div className="space-y-3">
				<div className="space-y-1">
					<Label className="text-[11px] text-muted-foreground">
						{t("settings.customProviders.dialog.field.api")}
					</Label>
					<Select value={form.api} onValueChange={(v) => patchForm("api", v as ApiProtocol)}>
						<SelectTrigger className="h-8 w-full">
							<SelectValue placeholder={t("settings.customProviders.dialog.placeholder.api")}>
								{t(`settings.customProviders.dialog.protocol.${form.api}`, API_PROTOCOL_LABELS[form.api] ?? "")}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="openai-completions">OpenAI Chat Completions</SelectItem>
							<SelectItem value="anthropic-messages">Anthropic Messages</SelectItem>
							<SelectItem value="google-generative-ai">Google Generative AI</SelectItem>
							<SelectItem value="openai-responses">OpenAI Responses</SelectItem>
						</SelectContent>
					</Select>
				</div>

				<div className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2">
					<div className="space-y-1">
						<Label className="text-[11px] text-muted-foreground">
							{t("settings.customProviders.dialog.field.name")} <span className="text-rose-500">*</span>
						</Label>
						<Input
							value={form.name}
							onChange={(e) => patchForm("name", e.target.value)}
							placeholder={t("settings.customProviders.dialog.placeholder.name")}
							disabled={isEdit}
							aria-invalid={errors.name}
							className="h-8 text-[12px] font-mono"
						/>
						<p
							className={cn(
								"text-[10px] leading-tight",
								errors.name ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground/60",
							)}
						>
							{t("settings.customProviders.dialog.field.nameHint")}
						</p>
					</div>
					<div className="space-y-1">
						<Label className="text-[11px] text-muted-foreground">
							{t("settings.customProviders.dialog.field.baseUrl")} <span className="text-rose-500">*</span>
						</Label>
						<Input
							value={form.baseUrl}
							onChange={(e) => patchForm("baseUrl", e.target.value)}
							placeholder={t("settings.customProviders.dialog.placeholder.baseUrl")}
							aria-invalid={errors.baseUrl}
							className="h-8 text-[12px] font-mono"
						/>
					</div>
				</div>

				<div className="space-y-1">
					<Label className="text-[11px] text-muted-foreground">
						{t("settings.customProviders.dialog.field.apiKey")} <span className="text-rose-500">*</span>
					</Label>
					<div className="relative">
						<Input
							type={form.showKey ? "text" : "password"}
							autoComplete="new-password"
							value={form.apiKey}
							onChange={(e) => patchForm("apiKey", e.target.value)}
							placeholder={t("settings.customProviders.dialog.placeholder.apiKey")}
							aria-invalid={errors.apiKey}
							className="h-8 pr-9 text-[12px] font-mono"
						/>
						<Button
							variant="ghost"
							size="icon"
							className="absolute right-0 top-0 size-8"
							onClick={() => patchForm("showKey", !form.showKey)}
							tabIndex={-1}
						>
							{form.showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
						</Button>
					</div>
					<p className="text-[10px] text-muted-foreground/60 leading-tight">
						{t("settings.customProviders.dialog.field.apiKeyHint")}
					</p>
				</div>
			</div>
		</section>
	);
}
