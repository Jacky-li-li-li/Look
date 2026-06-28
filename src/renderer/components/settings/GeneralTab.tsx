// ============================================================
// GeneralTab — Appearance + Behavior settings
// ============================================================

import { Card, CardContent, CardHeader, CardTitle } from "@shared/components/ui/card";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@shared/components/ui/select";
import { Switch } from "@shared/components/ui/switch";
import { Cpu, Sun, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ThemePicker } from "./ThemePicker";

const api = (window as any).look;

/** Sentinel value for the "Title generation model" Select. Models are
 *  serialized as `"provider/model-id"`, so this string can never collide
 *  with a real option; we use it to represent `null` (inherit the current
 *  session's model) so Radix Select always has a controlled value. */
const USE_SESSION_MODEL = "__session__";

function SettingRow({
	label,
	desc,
	id,
	children,
}: {
	label: string;
	desc: string;
	id?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col items-start justify-between gap-3 py-2.5 sm:flex-row sm:items-center sm:gap-4">
			<div className="flex min-w-0 flex-col gap-0.5">
				<label htmlFor={id} className="cursor-pointer text-[13px] font-medium leading-snug">
					{label}
				</label>
				<span className="text-[11px] leading-tight text-muted-foreground">{desc}</span>
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

export default function GeneralTab() {
	const { t, i18n } = useTranslation();
	const [language, setLanguage] = useState("en");
	const [autoCollapse, setAutoCollapse] = useState(true);
	const [compactionEnabled, setCompactionEnabled] = useState(true);
	const [autoTitleModel, setAutoTitleModel] = useState<string | null>(null);
	const [availableModels, setAvailableModels] = useState<Array<{ provider: string; id: string; name: string }>>([]);

	useEffect(() => {
		if (!api) return;
		api.getGeneralSettings()
			.then((r: any) => {
				if (r?.success && r.settings) {
					if (r.settings.language) setLanguage(r.settings.language);
					if (r.settings.autoCollapse !== undefined) setAutoCollapse(r.settings.autoCollapse);
					if (r.settings.compactionEnabled !== undefined) setCompactionEnabled(r.settings.compactionEnabled);
					if ("autoTitleModel" in r.settings) setAutoTitleModel(r.settings.autoTitleModel);
				}
			})
			.catch(() => {});
		api.getModels()
			.then((r: any) => {
				if (r?.models) {
					setAvailableModels(
						r.models.map((m: any) => ({
							provider: m.provider,
							id: m.id,
							name: m.name ?? m.id,
						})),
					);
				}
			})
			.catch(() => {});
	}, []);

	const persistSettings = (partial: Record<string, any>) => {
		if (!api) return;
		api.setGeneralSettings(partial).catch(() => {});
	};

	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto gap-3 p-4">
			<Card size="sm" className="overflow-visible">
				<CardHeader className="border-b border-hairline px-4 py-2.5">
					<CardTitle className="flex items-center gap-1.5 text-[13px]">
						<Sun className="size-3.5 text-muted-foreground" />
						{t("settings.appearance")}
					</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col divide-y divide-hairline px-4 py-0">
					<div className="py-2.5">
						<ThemePicker />
					</div>
					<SettingRow id="language" label={t("settings.language")} desc={t("settings.interfaceLanguage")}>
						<Select
							value={language}
							onValueChange={(v) => {
								setLanguage(v);
								i18n.changeLanguage(v);
								persistSettings({ language: v });
							}}
						>
							<SelectTrigger id="language" size="sm" className="w-[110px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									<SelectItem value="en">English</SelectItem>
									<SelectItem value="zh">中文</SelectItem>
									<SelectItem value="ja">日本語</SelectItem>
								</SelectGroup>
							</SelectContent>
						</Select>
					</SettingRow>
				</CardContent>
			</Card>

			<Card size="sm" className="overflow-visible">
				<CardHeader className="border-b border-hairline px-4 py-2.5">
					<CardTitle className="flex items-center gap-1.5 text-[13px]">
						<Cpu className="size-3.5 text-muted-foreground" />
						{t("settings.behavior")}
					</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col divide-y divide-hairline px-4 py-0">
					<SettingRow id="autoclp" label={t("settings.autoCollapse")} desc={t("settings.autoCollapseDesc")}>
						<Switch
							id="autoclp"
							size="sm"
							checked={autoCollapse}
							onCheckedChange={(v) => {
								setAutoCollapse(v);
								persistSettings({ autoCollapse: v });
							}}
						/>
					</SettingRow>
					<SettingRow
						id="autotitle-model"
						label={t("settings.autoTitleModel")}
						desc={t("settings.autoTitleModelDesc")}
					>
						<Select
							value={autoTitleModel ?? USE_SESSION_MODEL}
							onValueChange={(v) => {
								const next = v === USE_SESSION_MODEL ? null : v;
								setAutoTitleModel(next);
								persistSettings({ autoTitleModel: next });
							}}
						>
							<SelectTrigger id="autotitle-model" size="sm" className="w-[240px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									<SelectItem value={USE_SESSION_MODEL}>{t("settings.autoTitleUseSessionModel")}</SelectItem>
									{availableModels.map((m) => (
										<SelectItem key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
											{m.name} ({m.provider})
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</SettingRow>
				</CardContent>
			</Card>

			<Card size="sm" className="overflow-visible">
				<CardHeader className="border-b border-hairline px-4 py-2.5">
					<CardTitle className="flex items-center gap-1.5 text-[13px]">
						<Zap className="size-3.5 text-muted-foreground" />
						{t("settings.autoCompress")}
					</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col divide-y divide-hairline px-4 py-0">
					<SettingRow id="autocompress" label={t("settings.autoCompress")} desc={t("settings.autoCompressDesc")}>
						<Switch
							id="autocompress"
							size="sm"
							checked={compactionEnabled}
							onCheckedChange={(v) => {
								setCompactionEnabled(v);
								persistSettings({ compactionEnabled: v });
							}}
						/>
					</SettingRow>
				</CardContent>
			</Card>
		</div>
	);
}
