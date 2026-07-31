// ============================================================
// SettingsPage — 设置页面（由 showSettingsAtom = true 时渲染）
// 页面布局：顶部 header（返回按钮 + 标题）+ 左侧导航 + 内容区
// ============================================================

import { Badge } from "@look/ui/components/ui/badge";
import { Button } from "@look/ui/components/ui/button";
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
		<div className="flex h-full min-h-0 flex-col">
			{/* 红绿灯行：仅用于 macOS 红绿灯显示与窗口拖拽，保持全宽 */}
			<div className="app-drag mac-titlebar-pad h-12 shrink-0" />
			{/* 主体：占满剩余宽度，从窗口最左开始 */}
			<Tabs value={tab} onValueChange={setTab} orientation="vertical" className="flex min-h-0 flex-1 gap-0">
				<div className="flex w-44 shrink-0 flex-col border-r border-hairline">
					<TabsList className="!justify-start flex-1 flex-col items-center rounded-none bg-transparent px-0 pb-0 pt-1 gap-0">
						<TabsTrigger
							value="profile"
							className="!h-auto !flex-none !w-auto justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-all duration-200"
						>
							<UserRound className="size-3.5" />
							{t("profile.title")}
						</TabsTrigger>
						<TabsTrigger
							value="general"
							className="!h-auto !flex-none !w-auto justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-all duration-200"
						>
							<Palette className="size-3.5" />
							{t("settings.general")}
						</TabsTrigger>
						<TabsTrigger
							value="prompt"
							className="!h-auto !flex-none !w-auto justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-all duration-200"
						>
							<FileText className="size-3.5" />
							{t("settings.chatPrompt")}
						</TabsTrigger>
						<TabsTrigger
							value="api-keys"
							className="!h-auto !flex-none !w-auto justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-all duration-200"
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
							className="!h-auto !flex-none !w-auto justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-all duration-200"
						>
							<MessageCircle className="size-3.5" />
							{t("settings.imChannels")}
						</TabsTrigger>
						<TabsTrigger
							value="mcp"
							className="!h-auto !flex-none !w-auto justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-all duration-200"
						>
							<Server className="size-3.5" />
							MCP
						</TabsTrigger>
						<TabsTrigger
							value="about"
							className="!h-auto !flex-none !w-auto justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-primary data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-all duration-200"
						>
							<Zap className="size-3.5" />
							{t("settings.about")}
						</TabsTrigger>
					</TabsList>
					{/* 返回按钮：置于左侧栏底部 */}
					<div className="flex shrink-0 items-center border-t border-hairline p-3">
						<Button
							variant="ghost"
							size="sm"
							className="gap-1 px-2.5 text-xs focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() => setShowSettings(false)}
						>
							<ArrowLeft className="size-3.5" />
							{t("marketplace.back")}
						</Button>
					</div>
				</div>

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
			</Tabs>
		</div>
	);
});

export type { ProviderInfo, ProviderModelInfo } from "./types";

export default SettingsPage;
