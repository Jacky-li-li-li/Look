// ============================================================
// AgentSquare — Agent 广场容器页面（Tab 切换 + 内容路由）
// ============================================================

import { cn } from "@look/ui";
import { useAtom, useAtomValue } from "jotai";
import { Bot, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { agentSquareTabAtom } from "../../store/agentDefinitionsAtoms";
import { sidebarEffectiveCollapsedAtom } from "../../store/atoms";
import { navigateMainView } from "../../store/viewNavigation";
import { WorkspacePageHeader } from "../workspace/WorkspacePageChrome";
import SkillsPanel from "./SkillsPanel";
import SubAgentPanel from "./SubAgentPanel";

export default function AgentSquare() {
	const { t } = useTranslation();
	const [tab, setTab] = useAtom(agentSquareTabAtom);
	const sidebarCollapsed = useAtomValue(sidebarEffectiveCollapsedAtom);

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<WorkspacePageHeader
				title={t("marketplace.title")}
				backLabel={t("marketplace.back")}
				onBack={() => navigateMainView("chat")}
				sidebarCollapsed={sidebarCollapsed}
				icon={Bot}
			/>

			<div className="flex min-h-0 flex-1 flex-col">
				<div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline bg-background/55 px-3 py-2 sm:px-5">
					<div
						className="inline-flex items-center gap-0.5 rounded-lg border border-hairline bg-muted/25 p-0.5"
						role="tablist"
					>
						<button
							type="button"
							role="tab"
							aria-selected={tab === "subagent"}
							onClick={() => setTab("subagent")}
							className={cn(
								"inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium transition-colors",
								tab === "subagent"
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							<Bot className="size-3.5" />
							{t("marketplace.subagents")}
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={tab === "skills"}
							onClick={() => setTab("skills")}
							className={cn(
								"inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium transition-colors",
								tab === "skills"
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							<WandSparkles className="size-3.5" />
							{t("marketplace.skills")}
						</button>
					</div>
					<span className="hidden text-[10px] text-muted-foreground sm:inline">
						{tab === "subagent" ? t("marketplace.subagents") : t("marketplace.skills")}
					</span>
				</div>

				<div className="min-h-0 flex-1 overflow-hidden p-3 sm:p-5">
					{tab === "subagent" ? <SubAgentPanel /> : <SkillsPanel />}
				</div>
			</div>
		</div>
	);
}
