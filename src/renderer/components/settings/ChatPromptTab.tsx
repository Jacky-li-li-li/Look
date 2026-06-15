// ============================================================
// ChatPromptTab — Agent name + system prompt
// ============================================================

import { Input } from "@shared/components/ui/input";
import { Textarea } from "@shared/components/ui/textarea";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { chatAgentNameAtom } from "../../store/atoms";
import { appStore } from "../../store/ipcHandler";

const api = (window as any).look;

export default function ChatPromptTab() {
	const { t } = useTranslation();
	const [chatAgentName, setChatAgentName] = useState("");
	const [chatSystemPrompt, setChatSystemPrompt] = useState("");

	useEffect(() => {
		if (!api) return;
		api.getGeneralSettings()
			.then((r: any) => {
				if (r?.success && r.settings) {
					if (r.settings.chatAgentName !== undefined) setChatAgentName(r.settings.chatAgentName);
					if (r.settings.chatSystemPrompt !== undefined) setChatSystemPrompt(r.settings.chatSystemPrompt);
				}
			})
			.catch(() => {});
	}, []);

	const persist = (partial: Record<string, any>) => {
		if (!api) return;
		if (partial.chatAgentName !== undefined) {
			appStore.set(chatAgentNameAtom, partial.chatAgentName);
		}
		api.setGeneralSettings(partial).catch(() => {});
	};

	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto gap-3 p-4">
			<div className="flex flex-col gap-3">
				<div className="flex flex-col gap-0.5">
					<h3 className="text-[13px] font-medium leading-none">{t("settings.agentName")}</h3>
					<span className="text-[11px] text-muted-foreground leading-tight">{t("settings.agentNameDesc")}</span>
				</div>
				<Input
					id="chatAgentName"
					placeholder={t("settings.agentNamePlaceholder")}
					value={chatAgentName}
					onChange={(e) => setChatAgentName(e.target.value)}
					onBlur={() => persist({ chatAgentName })}
					className="h-8 text-[13px]"
				/>
				<div className="flex flex-col gap-0.5 mt-3">
					<h3 className="text-[13px] font-medium leading-none">{t("settings.chatSystemPrompt")}</h3>
					<span className="text-[11px] text-muted-foreground leading-tight">
						{t("settings.chatSystemPromptDesc")}
					</span>
				</div>
				<Textarea
					id="chatSystemPrompt"
					placeholder={t("settings.chatSystemPromptPlaceholder")}
					value={chatSystemPrompt}
					onChange={(e) => setChatSystemPrompt(e.target.value)}
					onBlur={() => persist({ chatSystemPrompt })}
					className="min-h-[200px] text-[13px]"
				/>
			</div>
		</div>
	);
}
