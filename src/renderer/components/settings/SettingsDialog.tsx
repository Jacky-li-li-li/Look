// ============================================================
// SettingsDialog — Tabs framework + footer (Ink Wash)
// ============================================================

import { Badge } from "@shared/components/ui/badge";
import { Button } from "@shared/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@shared/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@shared/components/ui/tabs";
import { FileText, Key, MessageCircle, Palette, UserRound, Zap } from "lucide-react";
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import AboutTab from "./AboutTab";
import ApiKeysTab from "./ApiKeysTab";
import GeneralTab from "./GeneralTab";
import ImChannelsTab from "./ImChannelsTab";
import ProfileTab from "./ProfileTab";
import PromptTab from "./PromptTab";
import type { CustomProviderStats, ProviderInfo } from "./types";

const api = (window as any).look;

interface SettingsDialogProps {
	open: boolean;
	providers: ProviderInfo[];
	customStats: CustomProviderStats;
	onProvidersChange: (data: { providers: ProviderInfo[]; customStats: CustomProviderStats }) => void;
	onClose: () => void;
	defaultTab?: "general" | "api-keys" | "im-channels" | "about" | "profile";
}

const SettingsDialog = memo(function SettingsDialog({
	open,
	providers,
	customStats,
	onProvidersChange,
	onClose,
	defaultTab = "general",
}: SettingsDialogProps) {
	const { t, i18n } = useTranslation();
	const [tab, setTab] = useState<string>(defaultTab);
	// Adjust tab when defaultTab changes (inline during render)
	const [prevDefaultTab, setPrevDefaultTab] = useState(defaultTab);
	if (defaultTab !== prevDefaultTab) {
		setPrevDefaultTab(defaultTab);
		setTab(defaultTab);
	}

	const configured = providers.filter((p) => p.hasKey).length + customStats.configured;

	const handleResetDefaults = () => {
		if (api)
			api.resetGeneralSettings().then((r: any) => {
				if (r?.success && r.settings) {
					i18n.changeLanguage(r.settings.language ?? "en");
				}
			});
		toast.success(t("settings.resetDone"));
	};

	return (
		<Dialog open={open} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="flex h-[82vh] max-h-[82vh] w-[calc(100%-2rem)] max-w-3xl flex-col" showCloseButton>
				<DialogHeader>
					<DialogTitle>{t("settings.title")}</DialogTitle>
					<DialogDescription>{t("settings.description")}</DialogDescription>
				</DialogHeader>

				<Tabs value={tab} onValueChange={setTab} orientation="vertical" className="flex min-h-0 flex-1 gap-4">
					<TabsList className="!h-full !justify-start w-44 shrink-0 flex-col items-stretch rounded-none border-r border-hairline bg-transparent p-0 gap-0">
						<TabsTrigger
							value="general"
							className="!h-auto !flex-none w-full justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-foreground data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-colors"
						>
							<Palette className="size-3.5" />
							{t("settings.general")}
						</TabsTrigger>
						<TabsTrigger
							value="prompt"
							className="!h-auto !flex-none w-full justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-foreground data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-colors"
						>
							<FileText className="size-3.5" />
							{t("settings.chatPrompt")}
						</TabsTrigger>
						<TabsTrigger
							value="profile"
							className="!h-auto !flex-none w-full justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-foreground data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-colors"
						>
							<UserRound className="size-3.5" />
							{t("profile.title")}
						</TabsTrigger>
						<TabsTrigger
							value="api-keys"
							className="!h-auto !flex-none w-full justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-foreground data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-colors"
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
							className="!h-auto !flex-none w-full justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-foreground data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-colors"
						>
							<MessageCircle className="size-3.5" />
							{t("settings.imChannels")}
						</TabsTrigger>
						<TabsTrigger
							value="about"
							className="!h-auto !flex-none w-full justify-start gap-2.5 px-3 py-2.5 border-l-2 border-transparent rounded-none text-muted-foreground hover:text-foreground hover:bg-accent/30 data-[state=active]:border-foreground data-[state=active]:text-foreground data-[state=active]:bg-accent/20 data-[state=active]:shadow-none transition-colors"
						>
							<Zap className="size-3.5" />
							{t("settings.about")}
						</TabsTrigger>
					</TabsList>

					<TabsContent value="prompt" className="flex-1 min-w-0 min-h-0 data-[state=inactive]:hidden">
						<PromptTab />
					</TabsContent>

					<TabsContent value="profile" className="flex-1 min-w-0 min-h-0 data-[state=inactive]:hidden">
						<ProfileTab />
					</TabsContent>

					<TabsContent value="general" className="flex-1 min-w-0 min-h-0 data-[state=inactive]:hidden">
						<GeneralTab />
					</TabsContent>

					<TabsContent value="api-keys" className="flex-1 min-w-0 min-h-0 data-[state=inactive]:hidden">
						<ApiKeysTab providers={providers} customStats={customStats} onProvidersChange={onProvidersChange} />
					</TabsContent>

					<TabsContent value="im-channels" className="flex-1 min-w-0 min-h-0 data-[state=inactive]:hidden">
						<ImChannelsTab />
					</TabsContent>

					<TabsContent value="about" className="flex-1 min-w-0 min-h-0 data-[state=inactive]:hidden">
						<AboutTab providers={providers} customStats={customStats} />
					</TabsContent>
				</Tabs>

				<DialogFooter className="shrink-0 sm:justify-between">
					<Button variant="line" size="sm" className="h-7 text-[11px]" onClick={handleResetDefaults}>
						{t("settings.resetDefaults")}
					</Button>
					<Button variant="line-filled" size="sm" className="h-7 text-[11px]" onClick={onClose}>
						{t("common.close")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
});

// Re-export the types for backward compatibility
export type { ProviderInfo, ProviderModelInfo } from "./types";

export default SettingsDialog;
