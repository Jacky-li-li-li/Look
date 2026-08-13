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
import { aiAvatarAtom, messageAlignmentAtom, showToolExecutionAtom } from "../../store/settingsAtoms";
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
	compactionEnabled?: boolean;
	autoTitleModel?: string | null;
	planModel?: string | null;
	aiAvatar?: string | null;
	desktopNotifications?: "off" | "needs-action" | "all";
	messageAlignment?: "left" | "left-right";
	showToolExecution?: boolean;
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

/** 微缩气泡预览：模拟一条 AI 消息 + 一条用户消息的气泡排列。
 *  注意对比度：accent 在 dark 主题下是深灰、muted-foreground 太淡，
 *  用户气泡用 foreground 主色（跟随主题明暗），AI 气泡用 muted 中灰，
 *  保证在两个主题下都清晰可辨。 */
function BubblePreview({ mode }: { mode: "left" | "left-right" }) {
	const rows: Array<{ side: "left" | "right"; tone: "assistant" | "user" }> =
		mode === "left"
			? [
					{ side: "left", tone: "assistant" },
					{ side: "left", tone: "user" },
				]
			: [
					{ side: "left", tone: "assistant" },
					{ side: "right", tone: "user" },
				];
	return (
		<div className="flex w-[84px] flex-col gap-2">
			{rows.map((row, i) => (
				<div key={i} className={cn("flex items-center gap-1.5", row.side === "right" && "flex-row-reverse")}>
					<span
						className={cn(
							"size-2 shrink-0 rounded-full",
							row.tone === "user" ? "bg-foreground/80" : "bg-muted-foreground/50",
						)}
					/>
					<span
						className={cn(
							"h-3.5 rounded-[6px]",
							row.tone === "user" ? "w-11 bg-foreground/80" : "w-14 bg-muted-foreground/45",
						)}
					/>
				</div>
			))}
		</div>
	);
}

/** 会话显示模式磁贴：radio 语义，选中带 accent 对勾徽章，内嵌微缩气泡预览。 */
function MessageLayoutTile({
	selected,
	label,
	mode,
	onSelect,
}: {
	selected: boolean;
	label: string;
	mode: "left" | "left-right";
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={selected}
			aria-label={label}
			title={label}
			onClick={onSelect}
			className={cn(
				"relative flex h-16 w-28 flex-col items-center justify-center gap-1 rounded-md border transition-all duration-150",
				"hover:-translate-y-px hover:bg-accent/5",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
				selected ? "border-accent bg-accent/10" : "border-hairline bg-card/40",
			)}
		>
			<BubblePreview mode={mode} />
			<span className="text-[9px] leading-none text-muted-foreground">{label}</span>
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
	compactionEnabled: boolean;
	/** 只读展示：读自 SDK SettingsManager（settings.json: compaction.reserveTokens）。 */
	compactionReserveTokens: number;
	/** 只读展示：读自 SDK SettingsManager（settings.json: compaction.keepRecentTokens）。 */
	compactionKeepRecentTokens: number;
	autoTitleModel: string | null;
	planModel: string | null;
	aiAvatar: string | null;
	desktopNotifications: "off" | "needs-action" | "all";
	/** 消息气泡排列（left=全部靠左 / left-right=用户右、AI 左）。 */
	messageAlignment: "left" | "left-right";
	/** 消息流中是否显示工具执行细节（思考 + 工具调用）。 */
	showToolExecution: boolean;
	availableModels: Array<{ provider: string; id: string; name: string }>;
}

export default function GeneralTab() {
	const { t, i18n } = useTranslation();
	// Seed the language from the live i18n instance: startup already applied
	// the persisted setting, so this avoids the dropdown flashing "en" while
	// the async getGeneralSettings() round-trip is in flight.
	const [state, setState] = useState<GeneralSettingsState>({
		language: (SUPPORTED_LOCALES as string[]).includes(i18n.language) ? i18n.language : "en",
		compactionEnabled: true,
		compactionReserveTokens: 16384,
		compactionKeepRecentTokens: 20000,
		autoTitleModel: null,
		planModel: null,
		aiAvatar: null,
		desktopNotifications: "all",
		messageAlignment: "left-right",
		showToolExecution: true,
		availableModels: [],
	});
	const setAiAvatar = useSetAtom(aiAvatarAtom);
	const setMessageAlignment = useSetAtom(messageAlignmentAtom);
	const setShowToolExecution = useSetAtom(showToolExecutionAtom);
	const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
	// 三态：undefined=未悬停（预览跟随已选项），null=悬停在默认像素头像上
	const [hoveredAvatar, setHoveredAvatar] = useState<string | null | undefined>(undefined);
	const {
		language,
		compactionEnabled,
		compactionReserveTokens,
		compactionKeepRecentTokens,
		autoTitleModel,
		planModel,
		aiAvatar,
		desktopNotifications,
		messageAlignment,
		showToolExecution,
		availableModels,
	} = state;
	// 预览区跟随悬停（试穿），未悬停时跟随已选项
	const previewAvatar = hoveredAvatar !== undefined ? hoveredAvatar : aiAvatar;
	const previewUrl = getAiAvatarUrl(previewAvatar);

	// 选择 AI 头像：更新本地 state、持久化到主进程并同步全局 atom
	const selectAiAvatar = (next: string | null) => {
		setState((prev) => ({ ...prev, aiAvatar: next }));
		persistSettings({ aiAvatar: next });
		setAiAvatar(next);
	};

	// 选择会话显示模式：更新本地 state、持久化并同步全局 atom
	const selectMessageAlignment = (next: "left" | "left-right") => {
		setState((prev) => ({ ...prev, messageAlignment: next }));
		persistSettings({ messageAlignment: next });
		setMessageAlignment(next);
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
						...(settings.compactionEnabled !== undefined
							? { compactionEnabled: settings.compactionEnabled }
							: {}),
						...("compactionReserveTokens" in settings
							? { compactionReserveTokens: settings.compactionReserveTokens }
							: {}),
						...("compactionKeepRecentTokens" in settings
							? { compactionKeepRecentTokens: settings.compactionKeepRecentTokens }
							: {}),
						...("autoTitleModel" in settings ? { autoTitleModel: settings.autoTitleModel } : {}),
						...("planModel" in settings ? { planModel: settings.planModel } : {}),
						...("aiAvatar" in settings ? { aiAvatar: settings.aiAvatar } : {}),
						...("desktopNotifications" in settings
							? {
									desktopNotifications: settings.desktopNotifications as "off" | "needs-action" | "all",
								}
							: {}),
						...("messageAlignment" in settings
							? { messageAlignment: settings.messageAlignment as "left" | "left-right" }
							: {}),
						...("showToolExecution" in settings
							? { showToolExecution: settings.showToolExecution as boolean }
							: {}),
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
					{/* 会话显示模式：两个带图示的磁贴（左对齐 / 左右对齐） */}
					<div className="py-2.5">
						<div className="flex items-start justify-between gap-4">
							<div className="flex min-w-0 flex-col gap-0.5">
								<span className="text-[13px] font-medium leading-snug">{t("settings.messageLayout")}</span>
								<span className="text-[11px] leading-tight text-muted-foreground">
									{t("settings.messageLayoutDesc")}
								</span>
							</div>
							<div
								className="flex shrink-0 items-center gap-2"
								role="radiogroup"
								aria-label={t("settings.messageLayout")}
							>
								<MessageLayoutTile
									selected={messageAlignment === "left"}
									label={t("settings.messageLayoutLeft")}
									mode="left"
									onSelect={() => selectMessageAlignment("left")}
								/>
								<MessageLayoutTile
									selected={messageAlignment === "left-right"}
									label={t("settings.messageLayoutLeftRight")}
									mode="left-right"
									onSelect={() => selectMessageAlignment("left-right")}
								/>
							</div>
						</div>
					</div>
					<SettingRow id="ai-avatar" label={t("settings.aiAvatar")} desc={t("settings.aiAvatarDesc")}>
						{/* 头像选择浮层用 Radix Popover：portal 到 body，焦点与点击由 Radix 管理，
							不会被设置页覆盖层拦截 */}
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

								{/* 选择网格：默认像素头像在第一格，hover 试穿、点击提交并关闭。
									24 个 AI 头像 + 1 个默认 = 25 格，5 列排成 5×5 方阵（6 列会剩 1 格孤悬）。 */}
								<div
									className="grid grid-cols-5 gap-1.5"
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
					<SettingRow id="plan-model" label={t("settings.planModel")} desc={t("settings.planModelDesc")}>
						<Select
							value={planModel ?? USE_SESSION_MODEL}
							onValueChange={(v) => {
								const next = v === USE_SESSION_MODEL ? null : v;
								setState((prev) => ({ ...prev, planModel: next }));
								persistSettings({ planModel: next });
							}}
						>
							<SelectTrigger id="plan-model" size="sm" className="w-[240px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									<SelectItem value={USE_SESSION_MODEL}>{t("settings.planUseSessionModel")}</SelectItem>
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
						<Cpu className="size-3.5 text-muted-foreground" />
						{t("settings.behavior")}
					</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-col divide-y divide-hairline px-4 py-0">
					<SettingRow
						id="tool-exec"
						label={t("settings.showToolExecution")}
						desc={t("settings.showToolExecutionDesc")}
					>
						<Switch
							id="tool-exec"
							size="sm"
							checked={showToolExecution}
							onCheckedChange={(v) => {
								setState((prev) => ({ ...prev, showToolExecution: v }));
								persistSettings({ showToolExecution: v });
								// 同步全局 atom：MessageBlockList 实时过滤，无需重启生效
								setShowToolExecution(v);
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
					<SettingRow
						id="desktop-notifications"
						label={t("settings.desktopNotifications")}
						desc={t("settings.desktopNotificationsDesc")}
					>
						<Select
							value={desktopNotifications}
							onValueChange={(v) => {
								const next = v as "off" | "needs-action" | "all";
								setState((prev) => ({ ...prev, desktopNotifications: next }));
								persistSettings({ desktopNotifications: next });
							}}
						>
							<SelectTrigger id="desktop-notifications" size="sm" className="w-[160px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									<SelectItem value="all">{t("settings.desktopNotificationsAll")}</SelectItem>
									<SelectItem value="needs-action">{t("settings.desktopNotificationsNeedsAction")}</SelectItem>
									<SelectItem value="off">{t("settings.desktopNotificationsOff")}</SelectItem>
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
					{/* reserveTokens — 只读展示：读自 SDK SettingsManager.getCompactionReserveTokens() */}
					<SettingRow
						id="reserve-tokens"
						label={t("settings.reserveTokens")}
						desc={t("settings.reserveTokensDesc")}
					>
						<span className="font-mono text-[12px] tabular-nums text-muted-foreground/70">
							{compactionReserveTokens.toLocaleString()}
						</span>
					</SettingRow>
					{/* keepRecentTokens — 只读展示：读自 SDK SettingsManager.getCompactionKeepRecentTokens() */}
					<SettingRow
						id="keep-recent"
						label={t("settings.keepRecentTokens")}
						desc={t("settings.keepRecentTokensDesc")}
					>
						<span className="font-mono text-[12px] tabular-nums text-muted-foreground/70">
							{compactionKeepRecentTokens.toLocaleString()}
						</span>
					</SettingRow>
				</CardContent>
			</Card>
		</div>
	);
}
