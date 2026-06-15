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
import { Cpu, Moon, Sun, Zap } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

const api = (window as any).look;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

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
		<div className="flex items-center justify-between gap-4 py-2.5">
			<div className="flex flex-col gap-0.5 min-w-0">
				<label htmlFor={id} className="text-[13px] font-medium leading-none cursor-pointer">
					{label}
				</label>
				<span className="text-[11px] text-muted-foreground leading-tight">{desc}</span>
			</div>
			{children}
		</div>
	);
}

export default function GeneralTab() {
	const { t, i18n } = useTranslation();
	const { theme, setTheme } = useTheme();
	const [language, setLanguage] = useState("en");
	const [thinkingLevel, setThinkingLevel] = useState("medium");
	const [autoCollapse, setAutoCollapse] = useState(true);
	const [compactionEnabled, setCompactionEnabled] = useState(true);

	useEffect(() => {
		if (!api) return;
		api.getGeneralSettings()
			.then((r: any) => {
				if (r?.success && r.settings) {
					if (r.settings.language) setLanguage(r.settings.language);
					if (r.settings.defaultThinkingLevel) setThinkingLevel(r.settings.defaultThinkingLevel);
					if (r.settings.autoCollapse !== undefined) setAutoCollapse(r.settings.autoCollapse);
					if (r.settings.compactionEnabled !== undefined) setCompactionEnabled(r.settings.compactionEnabled);
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
			<Card size="sm">
				<CardHeader className="border-b border-hairline px-4 py-2.5">
					<CardTitle className="flex items-center gap-1.5 text-[13px]">
						<Sun className="size-3.5 text-muted-foreground" />
						{t("settings.appearance")}
					</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col divide-y divide-hairline px-4 py-0">
					<SettingRow
						id="theme"
						label={t("settings.theme")}
						desc={theme === "dark" ? t("settings.darkMode") : t("settings.lightMode")}
					>
						<div className="flex items-center gap-1.5">
							<Sun className="size-3.5 text-muted-foreground" />
							<Switch
								id="theme"
								size="sm"
								checked={theme === "dark"}
								onCheckedChange={(c) => setTheme(c ? "dark" : "light")}
							/>
							<Moon className="size-3.5 text-muted-foreground" />
						</div>
					</SettingRow>
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

			<Card size="sm">
				<CardHeader className="border-b border-hairline px-4 py-2.5">
					<CardTitle className="flex items-center gap-1.5 text-[13px]">
						<Cpu className="size-3.5 text-muted-foreground" />
						{t("settings.behavior")}
					</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col divide-y divide-hairline px-4 py-0">
					<SettingRow id="thinking" label={t("settings.defaultThinking")} desc={t("settings.thinkingDesc")}>
						<Select
							value={thinkingLevel}
							onValueChange={(v) => {
								setThinkingLevel(v);
								persistSettings({ defaultThinkingLevel: v });
							}}
						>
							<SelectTrigger id="thinking" size="sm" className="w-[100px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{THINKING_LEVELS.map((l) => (
										<SelectItem key={l} value={l}>
											{l}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</SettingRow>
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
				</CardContent>
			</Card>

			<Card size="sm">
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
