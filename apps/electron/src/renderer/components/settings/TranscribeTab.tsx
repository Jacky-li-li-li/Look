// ============================================================
// TranscribeTab — 语音助手（本地语音转写）设置页
//
// 配置项：模型（下载/删除/切换）、转写语言、中文输出。
// 模型下载走双源回退（HF 官方 → hf-mirror），进度轮询。
// ============================================================

import type { TranscribeModelState, TranscribeSettingsDto } from "@look/shared/contracts/ipc";
import { Badge } from "@look/ui/components/ui/badge";
import { Button } from "@look/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@look/ui/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@look/ui/components/ui/select";
import { Check, Download, Mic, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const api = window.look;

function formatSize(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
	return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

function SettingRow({ label, desc, children }: { label: string; desc: string; children: React.ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col items-start justify-between gap-3 py-2.5 sm:flex-row sm:items-center sm:gap-4">
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="text-[13px] font-medium leading-snug">{label}</span>
				<span className="text-[11px] leading-tight text-muted-foreground">{desc}</span>
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

export default function TranscribeTab() {
	const { t } = useTranslation();
	const [models, setModels] = useState<TranscribeModelState[]>([]);
	const [settings, setSettings] = useState<TranscribeSettingsDto | null>(null);
	const [busy, setBusy] = useState(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const refresh = useCallback(async () => {
		if (!api) return;
		const result = await api.transcribeGetState();
		if (result.success && result.state) {
			setModels(result.state.models);
			setSettings(result.state.settings);
			const stillDownloading = result.state.models.some((m) => m.downloading);
			if (!stillDownloading && pollRef.current) {
				clearInterval(pollRef.current);
				pollRef.current = null;
			}
		}
	}, []);

	useEffect(() => {
		void refresh();
		return () => {
			if (pollRef.current) clearInterval(pollRef.current);
		};
	}, [refresh]);

	const startDownload = async (modelId: string) => {
		if (!api) return;
		await api.transcribeDownloadModel(modelId);
		// 下载中每 1.5s 轮询进度
		if (!pollRef.current) {
			pollRef.current = setInterval(() => void refresh(), 1500);
		}
		void refresh();
	};

	const deleteModel = async (modelId: string) => {
		if (!api) return;
		const model = models.find((m) => m.id === modelId);
		if (!model) return;
		if (!window.confirm(`${t("settings.transcribeDeleteConfirm")} (${model.name})?`)) return;
		setBusy(true);
		try {
			await api.transcribeDeleteModel(modelId);
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	const patchSettings = async (patch: Parameters<typeof api.transcribeSetSettings>[0]) => {
		if (!api) return;
		setBusy(true);
		try {
			const result = await api.transcribeSetSettings(patch);
			if (result.success && result.settings) setSettings(result.settings);
		} finally {
			setBusy(false);
		}
	};

	const currentModel = models.find((m) => m.id === settings?.modelId);
	const currentLanguages = currentModel?.languages ?? [];

	return (
		<div className="flex h-full flex-col gap-4 overflow-y-auto p-1">
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-[15px]">
						<Mic className="h-4 w-4" />
						{t("settings.transcribe")}
					</CardTitle>
					<p className="text-[12px] leading-relaxed text-muted-foreground">{t("settings.transcribeDesc")}</p>
				</CardHeader>
				<CardContent className="flex flex-col gap-3">
					{models.map((model) => {
						const inUse = model.id === settings?.modelId;
						return (
							<div
								key={model.id}
								className={`flex flex-col gap-2 rounded-xl border p-3 ${
									inUse ? "border-accent/60 bg-accent/5" : "border-hairline"
								}`}
							>
								<div className="flex items-center justify-between gap-3">
									<div className="flex min-w-0 flex-col gap-1">
										<div className="flex items-center gap-2">
											<span className="text-[13px] font-semibold">{model.name}</span>
											{inUse && (
												<Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
													<Check className="h-3 w-3" /> {t("settings.transcribeInUse")}
												</Badge>
											)}
											{model.streaming && (
												<Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px]">
													<Zap className="h-3 w-3" /> {t("settings.transcribeStreaming")}
												</Badge>
											)}
										</div>
										<span className="text-[11px] text-muted-foreground">
											{model.languages.slice(0, 6).join(" · ")}
											{model.languages.length > 6 ? ` +${model.languages.length - 6}` : ""}
											{" · "}
											{formatSize(model.size)}
										</span>
										{model.highlights.length > 0 && (
											<span className="mt-1 flex flex-wrap items-center gap-1">
												{model.highlights.map((key) => (
													<span
														key={key}
														className="rounded-full border px-1.5 py-0.5 text-[10px]"
														style={
															model.streaming
																? {
																		borderColor:
																			"color-mix(in oklab, oklch(0.46 0.11 158) 55%, transparent)",
																		background:
																			"color-mix(in oklab, oklch(0.46 0.11 158) 12%, transparent)",
																		// 固定中明度绿：浅色主题的 --status-success 可能过浅，文字用可读色
																		color: "oklch(0.46 0.11 158)",
																	}
																: {
																		borderColor:
																			"color-mix(in oklab, oklch(0.44 0.14 262) 55%, transparent)",
																		background:
																			"color-mix(in oklab, oklch(0.44 0.14 262) 12%, transparent)",
																		// 固定中明度蓝：同上，保证浅色主题可读
																		color: "oklch(0.44 0.14 262)",
																	}
														}
													>
														{t(key)}
													</span>
												))}
											</span>
										)}
										{model.error && (
											<span className="text-[11px] text-destructive">
												{t("settings.transcribeDownloadFailed")}: {model.error}
											</span>
										)}
									</div>
									<div className="flex shrink-0 items-center gap-2">
										{model.downloading ? (
											<div className="flex items-center gap-2">
												{model.progress !== null && model.progress > 0 ? (
													<>
														<div
															className="relative h-1.5 w-28 overflow-hidden rounded-full"
															style={{ background: "var(--muted)" }}
														>
															<div
																className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-200"
																style={{ width: `${model.progress}%`, background: "var(--primary)" }}
															/>
														</div>
														<span className="w-10 text-right text-[11px] tabular-nums text-muted-foreground">
															{model.progress}%
														</span>
													</>
												) : (
													// 0% 通常是还在连接/切换下载源（官方源黑洞 → 镜像源），
													// 直接展示"连接中"而不是误导性的 0%。
													<span className="text-[11px] text-muted-foreground">
														{t("settings.transcribeConnecting")}
													</span>
												)}
											</div>
										) : model.cached ? (
											<>
												<Button
													size="sm"
													variant={inUse ? "secondary" : "default"}
													disabled={inUse || busy}
													onClick={() => void patchSettings({ modelId: model.id })}
												>
													{inUse ? t("settings.transcribeInUse") : t("settings.transcribeUse")}
												</Button>
												<Button
													size="sm"
													variant="ghost"
													disabled={busy}
													onClick={() => void deleteModel(model.id)}
												>
													<Trash2 className="h-3.5 w-3.5" />
												</Button>
											</>
										) : (
											<Button size="sm" disabled={busy} onClick={() => void startDownload(model.id)}>
												<Download className="mr-1 h-3.5 w-3.5" />
												{t("settings.transcribeDownload")} · {formatSize(model.size)}
											</Button>
										)}
									</div>
								</div>
							</div>
						);
					})}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-[15px]">{t("settings.transcribeOptions")}</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col gap-1">
					<SettingRow label={t("settings.transcribeLanguage")} desc={t("settings.transcribeLanguageDesc")}>
						<Select
							value={settings?.transcriptionLanguage ?? "auto"}
							disabled={!settings || busy}
							onValueChange={(value) => void patchSettings({ transcriptionLanguage: value })}
						>
							<SelectTrigger className="w-48">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="auto">{t("settings.transcribeAuto")}</SelectItem>
								{currentLanguages.map((lang) => (
									<SelectItem key={lang} value={lang}>
										{lang}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</SettingRow>
					<SettingRow
						label={t("settings.transcribeChineseOutput")}
						desc={t("settings.transcribeChineseOutputDesc")}
					>
						<Select
							value={settings?.chineseOutput ?? "simplified"}
							disabled={!settings || busy}
							onValueChange={(value) =>
								void patchSettings({
									chineseOutput: value as "simplified" | "traditional-taiwan" | "traditional-hong-kong",
								})
							}
						>
							<SelectTrigger className="w-48">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="simplified">{t("settings.transcribeSimplified")}</SelectItem>
								<SelectItem value="traditional-taiwan">{t("settings.transcribeTraditionalTW")}</SelectItem>
								<SelectItem value="traditional-hong-kong">{t("settings.transcribeTraditionalHK")}</SelectItem>
							</SelectContent>
						</Select>
					</SettingRow>
				</CardContent>
			</Card>
		</div>
	);
}
