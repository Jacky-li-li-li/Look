// ============================================================
// SettingsPage — 设置页面（由 showSettingsAtom = true 时渲染）
// 页面布局：顶部 macOS 红绿灯拖拽区 + 左侧导航（含底部返回按钮）+ 内容区
// ============================================================

import { Badge } from "@look/ui/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@look/ui/components/ui/tabs";
import { useSetAtom } from "jotai";
import { ArrowLeft, FileText, Key, MessageCircle, Palette, Server, UserRound, Zap } from "lucide-react";
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsTab } from "../../store/atoms";
import { showSettingsAtom } from "../../store/atoms";
import AboutTab from "./AboutTab";
import ApiKeysTab from "./ApiKeysTab";
import GeneralTab from "./GeneralTab";
import ImChannelsTab from "./ImChannelsTab";
import McpServersTab from "./McpServersTab";
import ProfileTab from "./ProfileTab";
import PromptTab from "./PromptTab";
import type { CustomProviderInput, CustomProviderStats, ProviderInfo } from "./types";

interface SettingsPageProps {
	providers: ProviderInfo[];
	customProviders: CustomProviderInput[];
	customStats: CustomProviderStats;
	onProvidersChange: (data: {
		providers: ProviderInfo[];
		customProviders: CustomProviderInput[];
		customStats: CustomProviderStats;
	}) => void;
	defaultTab?: SettingsTab;
}

const SettingsPage = memo(function SettingsPage({
	providers,
	customProviders,
	customStats,
	onProvidersChange,
	defaultTab = "profile",
}: SettingsPageProps) {
	const { t } = useTranslation();
	const setShowSettings = useSetAtom(showSettingsAtom);
	const [tab, setTab] = useState<string>(defaultTab);
	// Adjust tab when defaultTab changes (inline during render)
	const [prevDefaultTab, setPrevDefaultTab] = useState(defaultTab);
	if (defaultTab !== prevDefaultTab) {
		setPrevDefaultTab(defaultTab);
		setTab(defaultTab);
	}

	const configured = providers.filter((p) => p.hasKey).length + customStats.configured;

	return (
		<Tabs value={tab} onValueChange={setTab} orientation="vertical" className="flex h-full min-h-0 gap-0">
			{/* 左侧导航：红绿灯拖拽区 + 导航项 + 返回按钮；border-r 分割线从窗口顶部贯穿到底 */}
			<div className="flex w-44 shrink-0 flex-col border-r border-hairline">
				{/* 红绿灯行：macOS 非全屏时为红绿灯按钮留白并承担窗口拖拽 */}
				<div className="app-drag mac-titlebar-pad h-12 shrink-0" />
				<TabsList className="!w-full !justify-start flex-1 flex-col items-stretch rounded-none bg-transparent px-2 pb-0 pt-1 gap-0">
					<TabsTrigger
						value="profile"
						className="!h-auto !flex-none !w-full justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-all duration-200"
					>
						<UserRound className="size-3.5" />
						{t("profile.title")}
					</TabsTrigger>
					<TabsTrigger
						value="general"
						className="!h-auto !flex-none !w-full justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-all duration-200"
					>
						<Palette className="size-3.5" />
						{t("settings.general")}
					</TabsTrigger>
					<TabsTrigger
						value="prompt"
						className="!h-auto !flex-none !w-full justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-all duration-200"
					>
						<FileText className="size-3.5" />
						{t("settings.chatPrompt")}
					</TabsTrigger>
					<TabsTrigger
						value="api-keys"
						className="!h-auto !flex-none !w-full justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-all duration-200"
					>
						<Key className="size-3.5" />
						<span className="flex-1 text-left">{t("settings.apiKeys")}</span>
						{configured > 0 && (
							<Badge variant="secondary" className="ml-auto h-4 px-1.5 text-[9px]">
								{configured}
							</Badge>
						)}
					</TabsTrigger>
					<TabsTrigger
						value="im-channels"
						className="!h-auto !flex-none !w-full justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-all duration-200"
					>
						<MessageCircle className="size-3.5" />
						{t("settings.imChannels")}
					</TabsTrigger>
					<TabsTrigger
						value="mcp"
						className="!h-auto !flex-none !w-full justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-all duration-200"
					>
						<Server className="size-3.5" />
						MCP
					</TabsTrigger>
					<TabsTrigger
						value="about"
						className="!h-auto !flex-none !w-full justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-all duration-200"
					>
						<Zap className="size-3.5" />
						{t("settings.about")}
					</TabsTrigger>
				</TabsList>
				{/* 返回按钮：置于左侧栏底部，整行可点击；图标置于圆角底衬中（与会话侧栏底部按钮同构），
					悬停时底衬加深、图标提亮，文本保持 muted */}
				<button
					type="button"
					onClick={() => setShowSettings(false)}
					className="group flex h-10 shrink-0 items-center gap-2.5 border-t border-hairline px-2 text-left transition-colors hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span className="inline-flex size-5 items-center justify-center rounded-[5px] bg-foreground/[0.06] transition-colors group-hover:bg-foreground/[0.12]">
						<ArrowLeft className="size-3 text-foreground/40 transition-colors group-hover:text-foreground/60" />
					</span>
					<span className="text-[11px] font-medium text-muted-foreground">{t("marketplace.back")}</span>
				</button>
			</div>

			{/* 内容区：顶部拖拽区（与红绿灯行同高，保持整行可拖拽）+ Tab 内容 */}
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="app-drag h-12 shrink-0" />

				<TabsContent
					value="profile"
					className="flex-1 min-w-0 min-h-0 overflow-y-auto data-[state=inactive]:hidden"
				>
					<ProfileTab />
				</TabsContent>

				<TabsContent
					value="general"
					className="flex-1 min-w-0 min-h-0 overflow-y-auto data-[state=inactive]:hidden"
				>
					<GeneralTab />
				</TabsContent>

				<TabsContent value="prompt" className="flex-1 min-w-0 min-h-0 overflow-y-auto data-[state=inactive]:hidden">
					<PromptTab />
				</TabsContent>

				<TabsContent
					value="api-keys"
					className="flex-1 min-w-0 min-h-0 overflow-y-auto data-[state=inactive]:hidden"
				>
					<ApiKeysTab
						providers={providers}
						customProviders={customProviders}
						customStats={customStats}
						onProvidersChange={onProvidersChange}
					/>
				</TabsContent>

				<TabsContent
					value="im-channels"
					className="flex-1 min-w-0 min-h-0 overflow-y-auto data-[state=inactive]:hidden"
				>
					<ImChannelsTab />
				</TabsContent>

				<TabsContent value="mcp" className="flex-1 min-w-0 min-h-0 overflow-y-auto data-[state=inactive]:hidden">
					<McpServersTab />
				</TabsContent>

				<TabsContent value="about" className="flex-1 min-w-0 min-h-0 overflow-y-auto data-[state=inactive]:hidden">
					<AboutTab />
				</TabsContent>
			</div>
		</Tabs>
	);
});

export type { ProviderInfo, ProviderModelInfo } from "./types";

export default SettingsPage;
