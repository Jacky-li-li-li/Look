// ============================================================
// GeneralTab — Appearance + Behavior settings
// ============================================================

import { cn } from "@look/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@look/ui/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@look/ui/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@look/ui/components/ui/select";
import { Switch } from "@look/ui/components/ui/switch";
import { useSetAtom } from "jotai";
import { Check, Cpu, Sun, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_LOCALES } from "../../i18n";
import { AI_AVATARS, getAiAvatarUrl } from "../../lib/aiAvatars";
import { aiAvatarAtom } from "../../store/settingsAtoms";
import { PixelAgentAvatar } from "../PixelAgentAvatar";
import { ThemePicker } from "./ThemePicker";

const api = window.look;

/** Sentinel value for the "Title generation model" Select. Models are
 *  serialized as `"provider/model-id"`, so this string can never collide
 *  with a real option; we use it to represent `null` (inherit the current
 *  session's model) so Radix Select always has a controlled value. */
const USE_SESSION_MODEL = "__session__";

function persistSettings(partial: {
	language?: "en" | "zh" | "ja";
	autoCollapse?: boolean;
	compactionEnabled?: boolean;
	autoTitleModel?: string | null;
	aiAvatar?: string | null;
}) {
	if (!api) return;
	api.setGeneralSettings(partial).catch((err) => console.warn("[GeneralTab] setGeneralSettings failed:", err));
}

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

/** 头像选择网格中的单个磁贴：radio 语义，选中带 accent 对勾徽章。 */
function AvatarTile({
	selected,
	label,
	onSelect,
	onHover,
	children,
}: {
	selected: boolean;
	label: string;
	onSelect: () => void;
	onHover: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={selected}
			aria-label={label}
			title={label}
			onClick={onSelect}
			onMouseEnter={onHover}
			className={cn(
				"relative flex h-11 items-center justify-center rounded-md border transition-all duration-150",
				"hover:-translate-y-px hover:bg-accent/5",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
				selected ? "border-accent bg-accent/10" : "border-hairline bg-card/40",
			)}
		>
			{children}
			{selected && (
				<span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-accent text-accent-foreground ring-1 ring-background">
					<Check className="size-2.5" strokeWidth={3} />
				</span>
			)}
		</button>
	);
}

interface GeneralSettingsState {
	language: string;
	autoCollapse: boolean;
	compactionEnabled: boolean;
	autoTitleModel: string | null;
	aiAvatar: string | null;
	availableModels: Array<{ provider: string; id: string; name: string }>;
}

export default function GeneralTab() {
	const { t, i18n } = useTranslation();
	// Seed the language from the live i18n instance: startup already applied
	// the persisted setting, so this avoids the dropdown flashing "en" while
	// the async getGeneralSettings() round-trip is in flight.
	const [state, setState] = useState<GeneralSettingsState>({
		language: (SUPPORTED_LOCALES as string[]).includes(i18n.language) ? i18n.language : "en",
		autoCollapse: true,
		compactionEnabled: true,
		autoTitleModel: null,
		aiAvatar: null,
		availableModels: [],
	});
	const setAiAvatar = useSetAtom(aiAvatarAtom);
	const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
	// 三态：undefined=未悬停（预览跟随已选项），null=悬停在默认像素头像上
	const [hoveredAvatar, setHoveredAvatar] = useState<string | null | undefined>(undefined);
	const { language, autoCollapse, compactionEnabled, autoTitleModel, aiAvatar, availableModels } = state;
	// 预览区跟随悬停（试穿），未悬停时跟随已选项
	const previewAvatar = hoveredAvatar !== undefined ? hoveredAvatar : aiAvatar;
	const previewUrl = getAiAvatarUrl(previewAvatar);

	// 选择 AI 头像：更新本地 state、持久化到主进程并同步全局 atom
	const selectAiAvatar = (next: string | null) => {
		setState((prev) => ({ ...prev, aiAvatar: next }));
		persistSettings({ aiAvatar: next });
		setAiAvatar(next);
	};

	useEffect(() => {
		if (!api) return;
		api.getGeneralSettings()
			.then((r) => {
				if (r?.success && r.settings) {
					const settings = r.settings;
					setState((prev) => ({
						...prev,
						...(settings.language ? { language: settings.language } : {}),
						...(settings.autoCollapse !== undefined ? { autoCollapse: settings.autoCollapse } : {}),
						...(settings.compactionEnabled !== undefined
							? { compactionEnabled: settings.compactionEnabled }
							: {}),
						...("autoTitleModel" in settings ? { autoTitleModel: settings.autoTitleModel } : {}),
						...("aiAvatar" in settings ? { aiAvatar: settings.aiAvatar } : {}),
					}));
				}
			})
			.catch((err) => console.warn("[GeneralTab] getGeneralSettings failed:", err));
		api.getModels()
			.then((r) => {
				if (r?.success && r.models) {
					setState((prev) => ({
						...prev,
						availableModels: r.models.map((m) => ({
							provider: m.provider,
							id: m.id,
							name: m.name ?? m.id,
						})),
					}));
				}
			})
			.catch((err) => console.warn("[GeneralTab] getModels failed:", err));
	}, []);

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
					<SettingRow id="ai-avatar" label={t("settings.aiAvatar")} desc={t("settings.aiAvatarDesc")}>
						{/* 设置页是 Radix 模态 Dialog：body 会被设为 pointer-events:none，
							portal 到 body 的自定义浮层点不动，必须用 Radix Popover 才能点击 */}
						<Popover
							open={avatarPickerOpen}
							onOpenChange={(open) => {
								setAvatarPickerOpen(open);
								if (!open) setHoveredAvatar(undefined);
							}}
						>
							<PopoverTrigger asChild>
								<button
									id="ai-avatar"
									type="button"
									className="flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-card/40 transition-colors hover:bg-accent/10"
									aria-label={t("settings.aiAvatar")}
								>
									{/* getAiAvatarUrl 对未命中的 id 返回 undefined，需先取 url 判断，避免存储失效 id 时渲染破图 */}
									{(() => {
										const url = getAiAvatarUrl(aiAvatar);
										return url ? (
											<img src={url} alt="" className="h-7 w-7 rounded-full" />
										) : (
											<PixelAgentAvatar size="xs" />
										);
									})()}
								</button>
							</PopoverTrigger>
							<PopoverContent align="end" sideOffset={6} className="w-72 p-3">
								{/* 原位预览：头像的意义在消息区，所以选择也在消息行的微缩模型里做。
									悬停磁贴即可试穿（预览跟随悬停），点击才提交；keyed remount 触发换脸动效。 */}
								<div className="flex flex-col gap-1.5">
									<span className="text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
										{t("settings.aiAvatarPreview")}
									</span>
									<div className="flex items-start gap-2 rounded-md border border-hairline bg-muted/40 px-2.5 py-2">
										<span key={previewAvatar ?? "default"} className="avatar-preview-swap mt-0.5 shrink-0">
											{previewUrl ? (
												<img
													src={previewUrl}
													alt=""
													className="h-7 w-7 rounded-full border border-hairline object-cover"
												/>
											) : (
												<PixelAgentAvatar size="sm" />
											)}
										</span>
										<div className="flex min-w-0 flex-col gap-1">
											<span className="text-[10px] font-medium leading-none text-foreground">
												{t("chat.agent")}
											</span>
											<span className="rounded-md rounded-tl-none border border-hairline bg-card px-2 py-1 text-[11px] leading-snug text-muted-foreground">
												{t("settings.aiAvatarPreviewText")}
											</span>
										</div>
									</div>
								</div>

								<div className="my-2.5 border-t border-hairline" />

								{/* 选择网格：默认像素头像在第一格，hover 试穿、点击提交并关闭 */}
								<div
									className="grid grid-cols-6 gap-1.5"
									role="radiogroup"
									aria-label={t("settings.aiAvatar")}
									onMouseLeave={() => setHoveredAvatar(undefined)}
								>
									<AvatarTile
										selected={aiAvatar === null}
										label={t("settings.aiAvatarDefault")}
										onSelect={() => {
											selectAiAvatar(null);
											setAvatarPickerOpen(false);
										}}
										onHover={() => setHoveredAvatar(null)}
									>
										<span className="flex flex-col items-center gap-0.5">
											<PixelAgentAvatar size="xs" />
											<span className="text-[8px] leading-none text-muted-foreground">
												{t("settings.aiAvatarDefault")}
											</span>
										</span>
									</AvatarTile>
									{AI_AVATARS.map((avatar) => (
										<AvatarTile
											key={avatar.id}
											selected={aiAvatar === avatar.id}
											label={avatar.id}
											onSelect={() => {
												selectAiAvatar(avatar.id);
												setAvatarPickerOpen(false);
											}}
											onHover={() => setHoveredAvatar(avatar.id)}
										>
											<img src={avatar.url} alt={avatar.id} className="h-7 w-7" />
										</AvatarTile>
									))}
								</div>

								{/* 底部：等宽字体报当前预览的头像 id（试穿时跟随悬停） */}
								<div className="mt-2.5 flex justify-end border-t border-hairline pt-2">
									<span className="font-mono text-[10px] text-muted-foreground">
										{previewAvatar ?? t("settings.aiAvatarDefault")}
									</span>
								</div>
							</PopoverContent>
						</Popover>
					</SettingRow>
					<SettingRow id="language" label={t("settings.language")} desc={t("settings.interfaceLanguage")}>
						<Select
							value={language}
							onValueChange={(v) => {
								const nextLanguage = v as "en" | "zh" | "ja";
								setState((prev) => ({ ...prev, language: nextLanguage }));
								i18n.changeLanguage(nextLanguage);
								persistSettings({ language: nextLanguage });
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
								setState((prev) => ({ ...prev, autoCollapse: v }));
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
								setState((prev) => ({ ...prev, autoTitleModel: next }));
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
								setState((prev) => ({ ...prev, compactionEnabled: v }));
								persistSettings({ compactionEnabled: v });
							}}
						/>
					</SettingRow>
					{/* reserveTokens — 读自 pi SDK SettingsManager.getCompactionReserveTokens()，settings.json 中配置 */}
					<SettingRow
						id="reserve-tokens"
						label={t("settings.reserveTokens")}
						desc={t("settings.reserveTokensDesc")}
					>
						<span className="font-mono text-[12px] tabular-nums text-muted-foreground/70">16384</span>
					</SettingRow>
					{/* keepRecentTokens — 同上 */}
					<SettingRow
						id="keep-recent"
						label={t("settings.keepRecentTokens")}
						desc={t("settings.keepRecentTokensDesc")}
					>
						<span className="font-mono text-[12px] tabular-nums text-muted-foreground/70">20000</span>
					</SettingRow>
				</CardContent>
			</Card>
		</div>
	);
}
